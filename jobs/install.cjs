#!/usr/bin/env node
/**
 * jobs/install.cjs — register (or re-point) the harness's scheduled jobs on Windows Task Scheduler.
 *
 *   node jobs/install.cjs            # show each job: registered action vs the action this repo wants
 *   node jobs/install.cjs --apply    # rewrite the action of every job that differs (never creates a trigger)
 *
 * The jobs are the repository's; their triggers (when they run) stay whatever the machine has,
 * so re-pointing a job after a checkout move changes the path and nothing else. A job that is not
 * registered is reported, not created: creating a schedule is the operator's decision
 * (`Register-ScheduledTask`, or the one-liner printed here).
 *
 * Private jobs (an operator's own briefings, watchdogs, audits) are not listed here; they live in
 * the private overlay and are registered from there.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const W = (p) => path.join(ROOT, p).replace(/\//g, '\\');
const CHOME = (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).replace(/\//g, '\\');
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

/**
 * name -> { execute, args, workingDirectory?, note, expects? }. Args are the exact Task Scheduler argument string.
 * expects {path, maxAgeH} is the job's dead-man contract: the artifact a good run leaves, and how old it may get
 * (`~/` is the home directory, `<repo>/` this repository). Read by doctor `jobs` and the opening-move digest:
 * a job that exits 0 but writes nothing reads as stale, not as clean. A job with no artifact has no contract.
 * resultNote {code: text} names what a non-zero exit means when it is the job's own verdict, not a crash.
 */
const JOBS = {
  HarnessParitySync: { execute: 'pwsh.exe', args: `-NoProfile -ExecutionPolicy Bypass -File "${W('jobs/port-daily.ps1')}"`, note: 'daily: capture Claude Code, port to every other client', expects: { path: '~/.claude/logs/port-daily.log', maxAgeH: 26 } },
  ClaudeErrorLog: { execute: BASH, args: W('jobs/errorlog/harvest.sh'), note: 'daily 06:22: harvest deviations and assumptions from transcripts', expects: { path: '~/.claude/logs/errorlog/harvest.log', maxAgeH: 26 } },
  ClaudeAgentReaper: { execute: 'wscript.exe', args: `"${W('jobs/reapers/agent-reaper-launcher.vbs')}"`, note: 'orphaned agent processes' },
  ClaudeLspReaper: { execute: 'wscript.exe', args: `"${W('jobs/reapers/lsp-reaper-launcher.vbs')}"`, note: 'orphaned language servers' },
  WesErrorLog: { execute: 'wscript.exe', args: `"${W('jobs/errorlog/daily-launcher.vbs')}"`, note: 'the human daily error log form' },
  'Harness Health Monthly': { execute: 'cmd', args: `/c pwsh -NoProfile -File "${W('tools/harness-health/harness-health.ps1')}" > "${CHOME}\\harness-health-last.txt" 2>&1`, note: 'settings-layer health report' },
  CronwatchDaily: { execute: process.execPath, args: `"${W('tools/cronwatch/cronwatch.cjs')}" --all`, workingDirectory: W('tools/cronwatch'), note: 'scheduled-job health board', expects: { path: '<repo>/tools/cronwatch/cronwatch.html', maxAgeH: 26, resultNote: { 1: 'board lists failed tasks' } } },
  DailyDistill: { execute: 'pwsh.exe', args: `-NoProfile -ExecutionPolicy Bypass -File "${W('jobs/daily-distill.ps1')}"`, note: 'daily 07:00: promotion ladder -> proposal', expects: { path: '<repo>/storage/daily-distill.log', maxAgeH: 26 } },
  OpeningMoveDigest: { execute: process.execPath, args: `"${W('jobs/opening-move-digest.cjs')}"`, workingDirectory: ROOT, note: 'daily 06:50: opening-move digest and T0 repairs', expects: { path: '~/.claude/state/opening-move/digest.json', maxAgeH: 26 } },
};
// Jobs another product chains into: only the argument that names a file in this repository changes.
const ARG_REWRITES = {
  NightlyMeditation: [[/--next-argument\s+"[^"]*run-nightly\.sh"/, `--next-argument "${W('jobs/meditation/run-nightly.sh')}"`]],
};
// Contracts for jobs whose action this file does not own (ARG_REWRITES) or whose artifact is a redirect target.
const EXPECTS = {
  NightlyMeditation: { path: '~/.claude/meditations/digests/latest-line.txt', maxAgeH: 26 },
  'Harness Health Monthly': { path: '~/.claude/harness-health-last.txt', maxAgeH: 768 },
};

/** Every contract, its path expanded: [{name, path (as written), file (absolute), maxAgeH}], JOBS first. */
function contracts(home = os.homedir()) {
  const expand = (p) => path.normalize(String(p).replace(/^~(?=[\\/])/, home).replace(/^<repo>(?=[\\/])/, ROOT));
  const out = [];
  for (const [name, j] of Object.entries(JOBS)) if (j.expects) out.push({ name, path: j.expects.path, file: expand(j.expects.path), maxAgeH: j.expects.maxAgeH, ...(j.expects.resultNote ? { resultNote: j.expects.resultNote } : {}) });
  for (const [name, e] of Object.entries(EXPECTS)) if (!out.some((c) => c.name === name)) out.push({ name, path: e.path, file: expand(e.path), maxAgeH: e.maxAgeH });
  return out;
}
/**
 * Each contract's artifact now: {...contract, state: 'fresh'|'stale'|'missing', ageMs}. Pure fs; no Task Scheduler
 * call. `list` replaces the contracts (the opening-move fixture plants a fake one through this same evaluator).
 */
function contractStatus({ now = Date.now(), home, list } = {}) {
  return (list || contracts(home)).map((c) => {
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(c.file).mtimeMs; } catch (_) {}
    if (mtimeMs == null) return { ...c, state: 'missing', ageMs: null };
    const ageMs = Math.max(0, now - mtimeMs);
    return { ...c, state: ageMs > c.maxAgeH * 3600e3 ? 'stale' : 'fresh', ageMs };
  });
}
/** Does a registered action (have: {execute, args, wd}) differ from what this repository wants? null: not ours to compare. */
function differs(name, have) {
  const want = JOBS[name];
  if (want) return !(String(have.execute).toLowerCase() === want.execute.toLowerCase() && String(have.args || '').trim() === want.args.trim() && (!want.workingDirectory || String(have.wd || '').toLowerCase() === want.workingDirectory.toLowerCase()));
  const rules = ARG_REWRITES[name];
  if (!rules) return null;
  let args = String(have.args || '');
  for (const [re, to] of rules) args = args.replace(re, to);
  return args !== String(have.args || '');
}
/** Every job name this file knows: JOBS, then ARG_REWRITES, then EXPECTS, each once. */
const knownJobs = () => [...new Set([...Object.keys(JOBS), ...Object.keys(ARG_REWRITES), ...Object.keys(EXPECTS)])];

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function current(name) {
  const r = ps(`$t = Get-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if ($t) { $a = $t.Actions[0]; ConvertTo-Json @{ execute = $a.Execute; args = $a.Arguments; wd = $a.WorkingDirectory } -Compress }`);
  if (!r.ok || !r.out) return null;
  try { return JSON.parse(r.out); } catch (_) { return null; }
}
function setAction(name, execute, args, wd) {
  const q = (s) => `'${String(s || '').replace(/'/g, "''")}'`;
  const script = `$a = New-ScheduledTaskAction -Execute ${q(execute)} -Argument ${q(args)}${wd ? ` -WorkingDirectory ${q(wd)}` : ''}; Set-ScheduledTask -TaskName ${q(name)} -Action $a | Out-Null; 'ok'`;
  return ps(script);
}

function main() {
  if (process.platform !== 'win32') { console.log('jobs/install: Windows Task Scheduler only; nothing to do here'); return 0; }
  const apply = process.argv.includes('--apply');
  let differ = 0, missing = 0, changed = 0;
  const rows = [];
  for (const [name, want] of Object.entries(JOBS)) {
    const have = current(name);
    if (!have) { missing++; rows.push(`MISSING  ${name}: not registered. ${want.note}. Register with a trigger of your choice, action: ${want.execute} ${want.args}`); continue; }
    if (!differs(name, have)) { rows.push(`ok       ${name}`); continue; }
    differ++;
    if (apply) { const r = setAction(name, want.execute, want.args, want.workingDirectory); if (r.ok) { changed++; rows.push(`UPDATED  ${name} -> ${want.args}`); } else rows.push(`FAILED   ${name}: ${r.err.slice(0, 160)}`); }
    else rows.push(`DIFFERS  ${name}\n           has:  ${have.execute} ${have.args}\n           want: ${want.execute} ${want.args}`);
  }
  for (const [name, rules] of Object.entries(ARG_REWRITES)) {
    const have = current(name);
    if (!have) { rows.push(`absent   ${name} (chained by another product; nothing to re-point)`); continue; }
    let args = String(have.args || '');
    for (const [re, to] of rules) args = args.replace(re, to);
    if (args === String(have.args || '')) { rows.push(`ok       ${name}`); continue; }
    differ++;
    if (apply) { const r = setAction(name, have.execute, args, have.wd); if (r.ok) { changed++; rows.push(`UPDATED  ${name} -> ${args}`); } else rows.push(`FAILED   ${name}: ${r.err.slice(0, 160)}`); }
    else rows.push(`DIFFERS  ${name}\n           has:  ${have.args}\n           want: ${args}`);
  }
  console.log(rows.join('\n'));
  console.log(`\njobs: ${Object.keys(JOBS).length + Object.keys(ARG_REWRITES).length} known, ${differ} differ, ${missing} missing${apply ? `, ${changed} updated` : ' (run with --apply to re-point)'}`);
  return apply && changed !== differ ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { JOBS, ARG_REWRITES, EXPECTS, contracts, contractStatus, knownJobs, differs, ROOT };
