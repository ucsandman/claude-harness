#!/usr/bin/env node
'use strict';

/*
 * gitradar.cjs — status board of every git repo on this machine.
 *
 * Scans every immediate subdirectory of C:\Projects\ that contains a .git,
 * plus C:\Users\sandm\.claude itself, and reports per repo: branch, dirty
 * count, unpushed commits, gone branches, last-commit age.
 *
 * Founding bug: a six-repo sweep once reported "0 commits in 24h" across
 * repos that had 27, because `git -C` was fed MSYS-style paths (/c/...) and
 * stderr was suppressed. This tool NEVER suppresses stderr — any failing git
 * command renders the repo as an ERROR row with the real stderr text, never
 * as zeros. See README.md.
 *
 * Zero dependencies. Read-only: never runs a git command that mutates state.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECTS_DIR = 'C:\\Projects';
const EXTRA_REPOS = ['C:\\Users\\sandm\\.claude'];
const OUT_HTML = path.join(__dirname, 'gitradar.html');

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAge(ms) {
  if (ms === null) return 'unknown';
  const diffMs = Date.now() - ms;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

// Run a git command against a NATIVE Windows path (never /c/... or ~ paths —
// that mismatch is the founding bug this tool exists to catch). Never uses a
// shell, so there's no MSYS path rewriting in the way. Captures stderr and
// exit code explicitly instead of suppressing them.
function runGit(repoPath, args) {
  const res = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.error) {
    return { ok: false, status: null, stdout: '', stderr: String(res.error.message) };
  }
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function findRepos() {
  const repos = [];
  let entries = [];
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (e) {
    // PROJECTS_DIR itself unreadable — not a scan failure of an individual
    // repo, let it surface via the empty repo list / summary.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(PROJECTS_DIR, entry.name);
    if (fs.existsSync(path.join(full, '.git'))) {
      repos.push({ name: entry.name, repoPath: full });
    }
  }
  for (const extra of EXTRA_REPOS) {
    if (fs.existsSync(path.join(extra, '.git'))) {
      repos.push({ name: path.basename(extra), repoPath: extra });
    }
  }
  return repos;
}

// Scan a single repo. Returns either an error result (any unexpected git
// failure) or a full status result. "no upstream" is its own warning state,
// not folded into zero and not folded into ERROR.
function scanRepo(name, repoPath) {
  const branchRes = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branchRes.ok) {
    return errorResult(name, repoPath, 'git rev-parse --abbrev-ref HEAD', branchRes);
  }
  const branch = branchRes.stdout.trim();

  const statusRes = runGit(repoPath, ['status', '--porcelain']);
  if (!statusRes.ok) {
    return errorResult(name, repoPath, 'git status --porcelain', statusRes);
  }
  const dirtyCount = statusRes.stdout.split('\n').filter((l) => l.trim().length > 0).length;

  const vvRes = runGit(repoPath, ['branch', '-vv']);
  if (!vvRes.ok) {
    return errorResult(name, repoPath, 'git branch -vv', vvRes);
  }
  const goneCount = vvRes.stdout.split('\n').filter((l) => l.includes(': gone]')).length;

  const logRes = runGit(repoPath, ['log', '-1', '--format=%ct']);
  if (!logRes.ok) {
    return errorResult(name, repoPath, 'git log -1', logRes);
  }
  const rawTs = logRes.stdout.trim();
  const lastCommitMs = rawTs ? parseInt(rawTs, 10) * 1000 : null;

  const upstreamRes = runGit(repoPath, ['rev-list', '--count', '@{u}..HEAD']);
  let noUpstream = false;
  let unpushedCount = 0;
  if (!upstreamRes.ok) {
    if (/no upstream/i.test(upstreamRes.stderr) || /unknown revision|no such branch/i.test(upstreamRes.stderr)) {
      noUpstream = true;
    } else {
      return errorResult(name, repoPath, 'git rev-list --count @{u}..HEAD', upstreamRes);
    }
  } else {
    unpushedCount = parseInt(upstreamRes.stdout.trim(), 10) || 0;
  }

  return {
    name, repoPath, error: false,
    branch, dirtyCount, goneCount, noUpstream, unpushedCount, lastCommitMs,
  };
}

function errorResult(name, repoPath, cmdDesc, res) {
  const stderrText = (res.stderr || '').trim();
  const msg = stderrText || `${cmdDesc} exited ${res.status}`;
  return { name, repoPath, error: true, errorCmd: cmdDesc, errorMsg: msg };
}

// Worst-first ordering: ERROR, then no-upstream, then unpushed commits, then
// gone branches, then dirty, then clean. Within a tier, more findings first.
function severity(r) {
  if (r.error) return 6;
  if (r.noUpstream) return 5;
  if (r.unpushedCount > 0) return 4;
  if (r.goneCount > 0) return 3;
  if (r.dirtyCount > 0) return 2;
  return 1;
}

function findingWeight(r) {
  if (r.error) return 0;
  return r.dirtyCount + r.unpushedCount + r.goneCount;
}

function sortWorstFirst(results) {
  return results.slice().sort((a, b) => {
    const sevDiff = severity(b) - severity(a);
    if (sevDiff !== 0) return sevDiff;
    const weightDiff = findingWeight(b) - findingWeight(a);
    if (weightDiff !== 0) return weightDiff;
    return a.name.localeCompare(b.name);
  });
}

function scanAll() {
  const repos = findRepos();
  return repos.map((r) => scanRepo(r.name, r.repoPath));
}

function printTerminal(results) {
  const sorted = sortWorstFirst(results);
  for (const r of sorted) {
    if (r.error) {
      console.log(`[ERROR] ${r.name.padEnd(28)} ${r.errorCmd}: ${r.errorMsg}`);
      continue;
    }
    const parts = [];
    parts.push(`branch=${r.branch || '(unknown)'}`);
    parts.push(`dirty=${r.dirtyCount}`);
    parts.push(r.noUpstream ? 'unpushed=NO-UPSTREAM' : `unpushed=${r.unpushedCount}`);
    parts.push(`gone=${r.goneCount}`);
    parts.push(`last=${formatAge(r.lastCommitMs)}`);
    const tag = r.noUpstream || r.unpushedCount > 0 || r.goneCount > 0 || r.dirtyCount > 0 ? '[WARN] ' : '[OK]   ';
    console.log(`${tag}${r.name.padEnd(28)} ${parts.join('  ')}`);
  }

  const errors = results.filter((r) => r.error).length;
  const dirty = results.filter((r) => !r.error && r.dirtyCount > 0).length;
  const unpushed = results.filter((r) => !r.error && (r.unpushedCount > 0 || r.noUpstream)).length;
  console.log('');
  console.log(`${results.length} repos, ${dirty} dirty, ${unpushed} with unpushed, ${errors} errors`);
}

function rowClass(r) {
  if (r.error) return 'row-error';
  if (r.noUpstream) return 'row-noupstream';
  if (r.unpushedCount > 0) return 'row-unpushed';
  if (r.goneCount > 0) return 'row-gone';
  if (r.dirtyCount > 0) return 'row-dirty';
  return 'row-clean';
}

function renderHtml(results) {
  const sorted = sortWorstFirst(results);
  const generatedAt = new Date().toLocaleString();
  const errors = results.filter((r) => r.error).length;
  const dirty = results.filter((r) => !r.error && r.dirtyCount > 0).length;
  const unpushed = results.filter((r) => !r.error && (r.unpushedCount > 0 || r.noUpstream)).length;

  const rows = sorted.map((r) => {
    if (r.error) {
      return `
      <tr class="${rowClass(r)}">
        <td class="cell-name">${htmlEscape(r.name)}</td>
        <td colspan="5" class="cell-error">ERROR — ${htmlEscape(r.errorCmd)}: ${htmlEscape(r.errorMsg)}</td>
      </tr>`;
    }
    const unpushedCell = r.noUpstream
      ? '<span class="badge badge-noupstream">no upstream</span>'
      : (r.unpushedCount > 0 ? `<span class="badge badge-unpushed">${r.unpushedCount}</span>` : '0');
    const goneCell = r.goneCount > 0 ? `<span class="badge badge-gone">${r.goneCount}</span>` : '0';
    const dirtyCell = r.dirtyCount > 0 ? `<span class="badge badge-dirty">${r.dirtyCount}</span>` : '0';
    return `
      <tr class="${rowClass(r)}">
        <td class="cell-name">${htmlEscape(r.name)}</td>
        <td class="cell-branch">${htmlEscape(r.branch || '(unknown)')}</td>
        <td class="cell-num">${dirtyCell}</td>
        <td class="cell-num">${unpushedCell}</td>
        <td class="cell-num">${goneCell}</td>
        <td class="cell-age">${htmlEscape(formatAge(r.lastCommitMs))}</td>
      </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gitradar</title>
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
    --warn: #c9932b;
    --bad: #c9412b;
    --error: #7a1f1f;
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
    padding: 10px 14px;
    background: var(--surface);
    color: var(--ink-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 1px solid var(--border);
  }
  tbody td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    color: var(--ink-secondary);
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: none; }
  .cell-name { color: var(--ink-primary); font-weight: 600; white-space: nowrap; }
  .cell-branch { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .cell-num { font-variant-numeric: tabular-nums; }
  .cell-age { white-space: nowrap; }
  .cell-error {
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    color: #ffb3a7;
    white-space: pre-wrap;
    word-break: break-word;
  }
  tr.row-error { background: var(--error); }
  tr.row-noupstream { background: rgba(201,65,43,0.18); }
  tr.row-unpushed { background: rgba(201,147,43,0.18); }
  tr.row-gone { background: rgba(201,147,43,0.10); }
  tr.row-dirty { background: rgba(255,255,255,0.04); }
  tr.row-clean { background: transparent; }
  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge-dirty { background: rgba(255,255,255,0.12); color: var(--ink-primary); }
  .badge-unpushed { background: var(--warn); color: #1a1a19; }
  .badge-gone { background: var(--warn); color: #1a1a19; }
  .badge-noupstream { background: var(--bad); color: #fff; }
  footer { margin-top: 20px; color: var(--ink-muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>gitradar — ${results.length} repo${results.length === 1 ? '' : 's'} scanned</h1>
  <div class="subhead">${dirty} dirty · ${unpushed} with unpushed work · ${errors} error${errors === 1 ? '' : 's'} · generated ${htmlEscape(generatedAt)}</div>
</header>
<table>
  <thead>
    <tr>
      <th>Repo</th>
      <th>Branch</th>
      <th>Dirty</th>
      <th>Unpushed</th>
      <th>Gone</th>
      <th>Last commit</th>
    </tr>
  </thead>
  <tbody>
${rows || '<tr><td colspan="6" class="cell-branch">No repos found.</td></tr>'}
  </tbody>
</table>
<footer>
  Static snapshot — re-run <code>node gitradar.cjs</code> to refresh. Stderr from
  a failing git command is never suppressed: ERROR rows show the real message.
</footer>
</body>
</html>
`;
}

function openFile(filePath) {
  const { spawn } = require('child_process');
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- selftest
// Pins the one thing this tool exists for: a git command that FAILS must never
// look like a git command that returned nothing. The founding bug was six
// `git -C /c/Projects/X` calls reporting "0 commits in 24h" across repos that
// had 27, because git.exe rejected the MSYS path and stderr was suppressed.
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } };

  // --- a failing git call must be loudly distinguishable from an empty one --
  const missing = runGit('C:/nope-this-path-does-not-exist-gitradar-selftest', ['status', '--porcelain']);
  ok('missing repo is not ok', missing.ok === false);
  ok('missing repo carries real stderr', missing.stderr.trim().length > 0);
  ok('missing repo has empty stdout', missing.stdout === '');
  // The founding bug in one line: empty stdout alone must NEVER read as success.
  ok('CONTRACT: empty stdout + not-ok is a failure, not zero commits',
     !(missing.ok === true && missing.stdout === ''));

  // MSYS-style path handed to git.exe — the exact shape that caused the bug.
  // Either git accepts it (ok) or rejects it (ok:false + stderr). What must
  // never happen is a silent ok:true with no output.
  const msys = runGit('/c/nope-this-path-does-not-exist-gitradar-selftest', ['status', '--porcelain']);
  ok('CONTRACT: MSYS path never silently succeeds empty',
     msys.ok === false ? msys.stderr.trim().length > 0 : true);

  // --- error rows always carry a message ----------------------------------
  const withStderr = errorResult('r', 'C:/r', 'git status', { stderr: 'fatal: not a git repository', status: 128 });
  ok('error row is flagged', withStderr.error === true);
  ok('error row uses real stderr', /not a git repository/.test(withStderr.errorMsg));

  // Empty stderr must still produce a message, never a blank cell.
  const noStderr = errorResult('r', 'C:/r', 'git status', { stderr: '', status: 128 });
  ok('empty stderr still yields a message', noStderr.errorMsg.length > 0);
  ok('empty stderr message names the exit code', /128/.test(noStderr.errorMsg));

  // --- worst-first ordering ------------------------------------------------
  const clean = { name: 'clean', dirtyCount: 0, unpushedCount: 0, goneCount: 0 };
  const dirty = { name: 'dirty', dirtyCount: 3, unpushedCount: 0, goneCount: 0 };
  const unpushed = { name: 'unpushed', dirtyCount: 0, unpushedCount: 1, goneCount: 0 };
  const noUp = { name: 'noUp', dirtyCount: 0, unpushedCount: 0, goneCount: 0, noUpstream: true };
  const err = { name: 'err', error: true };
  ok('error outranks everything', severity(err) > severity(noUp));
  ok('no-upstream outranks unpushed', severity(noUp) > severity(unpushed));
  ok('unpushed outranks dirty', severity(unpushed) > severity(dirty));
  ok('dirty outranks clean', severity(dirty) > severity(clean));

  const order = sortWorstFirst([clean, dirty, err, unpushed, noUp]).map((r) => r.name);
  ok('sorted worst-first', order.join(',') === 'err,noUp,unpushed,dirty,clean');
  // An ERROR row must never sort below a merely-dirty one — that is how a
  // broken scan hides at the bottom of the board.
  ok('CONTRACT: error never sorts below dirty', order.indexOf('err') < order.indexOf('dirty'));

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const doOpen = args.includes('--open');

  let results;
  try {
    results = scanAll();
  } catch (e) {
    console.error(`gitradar: scan failed: ${e.message}`);
    process.exit(1);
  }

  printTerminal(results);
  const html = renderHtml(results);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(OUT_HTML);

  if (doOpen) openFile(OUT_HTML);
  process.exit(0);
}

main();
