#!/usr/bin/env node
'use strict';

/*
 * cronwatch.cjs — health board for Windows Task Scheduler jobs.
 *
 * Task Scheduler jobs (FleetBriefing7am, NightlyMeditation, ...) fail
 * silently. This spawns PowerShell once to pull every scheduled task's
 * state/last-run/result/next-run/action, classifies each as
 * OK / FAILED / STALE / DISABLED, prints a terminal summary, and writes
 * cronwatch.html. Read-only: never registers, modifies, runs, or deletes
 * a task. Zero dependencies. See README.md.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const OUT_HTML = path.join(__dirname, 'cronwatch.html');
const DEFAULT_FILTER = /claude|fleet|meditat|briefing/i;
const NEVER_RUN_SENTINEL_YEAR = 2001; // Task Scheduler's "never run" LastRunTime is 1999-11-30

// PowerShell script run exactly once. Emits a JSON array; each element
// carries the raw fields needed to classify + render in Node. Actions is
// always forced into an array (even with one action) so Node never has to
// guess whether ConvertTo-Json collapsed a single-item array to a bare object.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$tasks = Get-ScheduledTask
$results = foreach ($t in $tasks) {
  try {
    $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop
  } catch {
    $info = $null
  }
  $actions = @()
  foreach ($a in $t.Actions) {
    $actions += [pscustomobject]@{ Execute = $a.Execute; Arguments = $a.Arguments }
  }
  [pscustomobject]@{
    TaskName = $t.TaskName
    TaskPath = $t.TaskPath
    State = $t.State.ToString()
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
    Actions = $actions
  }
}
$results | ConvertTo-Json -Depth 6 -Compress
`.trim();

// Known Task Scheduler result codes (decimal, matching how PowerShell/JSON
// serialize LastTaskResult as a signed Int32). Unknown nonzero codes fall
// back to a hex display.
const RESULT_CODES = {
  0: 'OK',
  1: 'generic failure (0x1)',
  2: 'file not found (0x2)',
  10: 'environment incorrect (0xa)',
  266496: 'ready — waiting for next run (0x41300)',
  266497: 'running (0x41301)',
  266498: 'disabled — will not run (0x41302)',
  267011: 'never run (0x41303)',
  267012: 'no more scheduled runs (0x41304)',
  267014: 'terminated by user (0x41306)',
  '-2147023585': 'already running (0x8004131F)',
  '-1073741510': 'terminated — ctrl+c (0xC000013A)',
};

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeResult(code) {
  if (code === null || code === undefined) return { text: 'unknown', code: null };
  if (RESULT_CODES[code] !== undefined) return { text: RESULT_CODES[code], code };
  const hex = (code >>> 0).toString(16);
  return { text: `error 0x${hex}`, code };
}

// PowerShell dates arrive either as ISO strings (pwsh 7 ConvertTo-Json) or
// as "/Date(1786652732129)/" (Windows PowerShell 5.1 ConvertTo-Json).
// Verified against real output from both engines on this machine before
// writing this — see README.md.
function parsePsDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const m = value.match(/^\/Date\((-?\d+)\)\/$/);
    if (m) return Number(m[1]);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function isNeverRunSentinel(ms) {
  if (ms === null) return false;
  return new Date(ms).getFullYear() < NEVER_RUN_SENTINEL_YEAR;
}

function findPowerShell() {
  for (const shell of ['pwsh', 'powershell']) {
    const probe = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
    });
    if (!probe.error) return shell;
  }
  return null;
}

function runQuery() {
  const shell = findPowerShell();
  if (!shell) {
    return { ok: false, stderr: 'neither pwsh nor powershell was found on PATH' };
  }
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, stderr: `${shell} failed to launch: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: `${shell} exited ${result.status}\n${result.stderr || '(no stderr)'}`,
    };
  }
  return { ok: true, shell, stdout: result.stdout };
}

function parseTasks(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`could not parse PowerShell JSON output: ${e.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list.map((raw) => {
    const lastRunMsRaw = parsePsDate(raw.LastRunTime);
    const nextRunMs = parsePsDate(raw.NextRunTime);
    const neverRun = isNeverRunSentinel(lastRunMsRaw);
    const lastRunMs = neverRun ? null : lastRunMsRaw;
    const actions = Array.isArray(raw.Actions) ? raw.Actions : raw.Actions ? [raw.Actions] : [];
    const actionText = actions
      .map((a) => [a && a.Execute, a && a.Arguments].filter(Boolean).join(' '))
      .join('; ');
    const resultCode = typeof raw.LastTaskResult === 'number' ? raw.LastTaskResult : null;
    const decoded = decodeResult(resultCode);

    let classification;
    if (raw.State === 'Disabled') {
      classification = 'DISABLED';
    } else if (resultCode === 266497) {
      // 0x41301: the task is running right now — status, not failure.
      classification = 'RUNNING';
    } else if (resultCode === 267011) {
      // 0x41303: never fired yet — neutral, not a red row.
      classification = 'NEVER-RUN';
    } else if (resultCode !== 0 && resultCode !== 266496) {
      // 0x41300 "ready — waiting for next run" is also status, not failure.
      classification = 'FAILED';
    } else {
      const cadence = lastRunMs !== null && nextRunMs !== null ? nextRunMs - lastRunMs : null;
      const stale =
        cadence !== null && cadence > 0 && Date.now() - lastRunMs > 2 * cadence;
      classification = stale ? 'STALE' : 'OK';
    }

    return {
      name: raw.TaskName || '(unnamed)',
      taskPath: raw.TaskPath || '\\',
      state: raw.State || 'Unknown',
      lastRunMs,
      neverRun,
      nextRunMs,
      resultCode,
      resultText: neverRun ? RESULT_CODES[267011] : decoded.text,
      actionText,
      classification,
    };
  });
}

function matchesFilter(task, re) {
  const haystack = `${task.name} ${task.taskPath} ${task.actionText}`;
  return re.test(haystack);
}

const CLASS_ORDER = { FAILED: 0, STALE: 1, 'NEVER-RUN': 2, DISABLED: 3, RUNNING: 4, OK: 5 };

function sortProblemsFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const c = CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification];
    if (c !== 0) return c;
    return a.name.localeCompare(b.name);
  });
}

function fmtDate(ms, neverRun) {
  if (neverRun) return 'never run';
  if (ms === null) return '—';
  return new Date(ms).toLocaleString();
}

function printTerminal(tasks) {
  const sorted = sortProblemsFirst(tasks);
  for (const t of sorted) {
    const tag = `[${t.classification}]`.padEnd(11);
    const name = t.name.length > 38 ? t.name.slice(0, 37) + '…' : t.name.padEnd(38);
    const state = (t.state || '').padEnd(9);
    const last = fmtDate(t.lastRunMs, t.neverRun).padEnd(22);
    const result = t.resultText.padEnd(32);
    const next = fmtDate(t.nextRunMs, false);
    console.log(`${tag} ${name} state=${state} last=${last} result=${result} next=${next}`);
  }
  const counts = { OK: 0, FAILED: 0, STALE: 0, 'NEVER-RUN': 0, RUNNING: 0, DISABLED: 0 };
  for (const t of tasks) counts[t.classification]++;
  console.log(
    `${tasks.length} tasks shown — ${counts.OK} OK, ${counts.RUNNING} RUNNING, ${counts.FAILED} FAILED, ${counts.STALE} STALE, ${counts['NEVER-RUN']} NEVER-RUN, ${counts.DISABLED} DISABLED`
  );
}

function renderHtml(tasks) {
  const sorted = sortProblemsFirst(tasks);
  const generatedAt = new Date().toLocaleString();
  const counts = { OK: 0, FAILED: 0, STALE: 0, 'NEVER-RUN': 0, RUNNING: 0, DISABLED: 0 };
  for (const t of tasks) counts[t.classification]++;

  const rows = sorted
    .map((t) => {
      const rowClass =
        t.classification === 'FAILED'
          ? 'row-failed'
          : t.classification === 'DISABLED' || t.classification === 'NEVER-RUN'
          ? 'row-disabled'
          : t.classification === 'STALE'
          ? 'row-stale'
          : '';
      return `
      <tr class="${rowClass}">
        <td><span class="badge badge-${t.classification.toLowerCase()}">${t.classification}</span></td>
        <td>
          <div class="name">${htmlEscape(t.name)}</div>
          <div class="path">${htmlEscape(t.taskPath)}</div>
        </td>
        <td>${htmlEscape(t.state)}</td>
        <td>${htmlEscape(fmtDate(t.lastRunMs, t.neverRun))}</td>
        <td>${htmlEscape(t.resultText)}</td>
        <td>${htmlEscape(fmtDate(t.nextRunMs, false))}</td>
        <td class="action">${htmlEscape(t.actionText) || '<span class="empty">(none)</span>'}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cronwatch</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink-primary: #ffffff;
    --ink-secondary: #c3c2b7;
    --ink-muted: #898781;
    --border: rgba(255,255,255,0.10);
    --good: #0ca30c;
    --bad: #d63b3b;
    --bad-bg: rgba(214,59,59,0.12);
    --stale: #d6a13b;
    --stale-bg: rgba(214,161,59,0.10);
    --disabled-bg: rgba(255,255,255,0.03);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  header { margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px 0; }
  .subhead { color: var(--ink-secondary); font-size: 14px; }
  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    font-size: 13px;
  }
  thead th {
    text-align: left;
    background: var(--surface);
    color: var(--ink-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    color: var(--ink-secondary);
  }
  tbody tr:last-child td { border-bottom: none; }
  .row-failed td { background: var(--bad-bg); }
  .row-stale td { background: var(--stale-bg); }
  .row-disabled td { background: var(--disabled-bg); color: var(--ink-muted); }
  .name { font-weight: 600; color: var(--ink-primary); }
  .row-disabled .name { color: var(--ink-muted); }
  .path { font-size: 11px; color: var(--ink-muted); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .action { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; word-break: break-word; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .badge-ok { background: rgba(12,163,12,0.15); color: var(--good); }
  .badge-failed { background: rgba(214,59,59,0.2); color: var(--bad); }
  .badge-stale { background: rgba(214,161,59,0.2); color: var(--stale); }
  .badge-disabled { background: rgba(255,255,255,0.08); color: var(--ink-muted); }
  .badge-running { background: rgba(59,130,214,0.2); color: #5b9bd5; }
  .badge-never-run { background: rgba(255,255,255,0.08); color: var(--ink-muted); }
  .empty { color: var(--ink-muted); font-style: italic; }
  footer { margin-top: 20px; color: var(--ink-muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>${counts.FAILED} failed, ${counts.STALE} stale scheduled task${tasks.length === 1 ? '' : 's'}</h1>
  <div class="subhead">${tasks.length} task${tasks.length === 1 ? '' : 's'} shown (${counts.OK} OK, ${counts.RUNNING} RUNNING, ${counts.FAILED} FAILED, ${counts.STALE} STALE, ${counts['NEVER-RUN']} NEVER-RUN, ${counts.DISABLED} DISABLED) · generated ${htmlEscape(generatedAt)}</div>
</header>
<table>
  <thead>
    <tr>
      <th>Health</th>
      <th>Task</th>
      <th>State</th>
      <th>Last run</th>
      <th>Result</th>
      <th>Next run</th>
      <th>Action</th>
    </tr>
  </thead>
  <tbody>
${rows || '<tr><td colspan="7" class="empty">No scheduled tasks matched.</td></tr>'}
  </tbody>
</table>
<footer>
  Static snapshot — re-run <code>node cronwatch.cjs</code> to refresh. Read-only: queries Task Scheduler only, never registers/modifies/runs/deletes a task.
</footer>
</body>
</html>
`;
}

function parseArgs(argv) {
  const args = { all: false, filter: null, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--open') args.open = true;
    else if (a === '--filter') {
      args.filter = argv[i + 1];
      i++;
    }
  }
  return args;
}

function openFile(filePath) {
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const queryResult = runQuery();
  if (!queryResult.ok) {
    console.error('[cronwatch] scheduler query failed:');
    console.error(queryResult.stderr);
    process.exit(1);
  }

  let allTasks;
  try {
    allTasks = parseTasks(queryResult.stdout);
  } catch (e) {
    console.error('[cronwatch] scheduler query failed:');
    console.error(e.message);
    console.error(`raw output (first 2000 chars):\n${(queryResult.stdout || '').slice(0, 2000)}`);
    process.exit(1);
  }

  let re;
  if (args.filter) {
    try {
      re = new RegExp(args.filter, 'i');
    } catch (e) {
      console.error(`[cronwatch] bad --filter regex: ${e.message}`);
      process.exit(1);
    }
  } else if (args.all) {
    re = /.*/;
  } else {
    re = DEFAULT_FILTER;
  }

  const shown = allTasks.filter((t) => matchesFilter(t, re));

  printTerminal(shown);
  const html = renderHtml(shown);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(OUT_HTML);

  if (args.open) openFile(OUT_HTML);

  // Exit nonzero when something is actually broken, so cronwatch's OWN Last
  // Result is meaningful once it runs on a schedule. Without this it always
  // exited 0 and the silent-failure detector was itself silent — which is how
  // "DashClaw Traffic Poll" failed ~40 mornings unseen.
  const broken = shown.filter((t) => t.classification === 'FAILED').length;
  if (broken > 0) {
    console.error(`[cronwatch] ${broken} scheduled task(s) FAILED — see ${OUT_HTML}`);
    process.exit(1);
  }

  process.exit(0);
}

main();
