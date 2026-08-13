#!/usr/bin/env node
'use strict';

/*
 * envdoctor.cjs — read-only checkup of secrets/env wiring on this machine.
 *
 * ============================================================================
 * HARD RULE: this tool NEVER opens, reads, cats, streams, or parses the
 * CONTENTS of C:\Users\sandm\.claude\.secrets.env or any other .env file.
 * Existence, size, and mtime come from fs.stat ONLY. The one exception is
 * .env.example files, which are placeholders (no real secrets) and may be
 * read to extract variable NAMES only. No env var VALUE is ever printed,
 * logged, or written anywhere — not to the terminal, not to envdoctor.html,
 * not to any intermediate file. Every check below reports names, presence,
 * and booleans only.
 * ============================================================================
 *
 * WHY THIS EXISTS: nothing on this machine checks env/secrets wiring today,
 * and three incidents already happened because of that gap:
 *   - A User-scope ANTHROPIC_API_KEY let a plugin worker burn $227.
 *   - BASH_ENV leaked secrets into a plugin hook's env, burning $95 on an
 *     Opus reviewer that shouldn't have had a key at all.
 *   - MCP servers hold stale env after a key rotation (no automated check
 *     here; call it out to the human instead).
 *   - PowerShell sessions can't see .secrets.env vars — that wiring is
 *     Bash-only (BASH_ENV), which surprises anyone reaching for a var in a
 *     PowerShell tool call.
 * envdoctor is a periodic read-only checkup so those classes of failure show
 * up as a checklist instead of a bill.
 *
 * Zero dependencies. See README.md for the check list and severities.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SECRETS_ENV_PATH = path.join(CLAUDE_HOME, '.secrets.env');
const SETTINGS_PATH = path.join(CLAUDE_HOME, 'settings.json');
const SETTINGS_LOCAL_PATH = path.join(CLAUDE_HOME, 'settings.local.json');
const PROJECTS_ROOT = 'C:\\Projects';
const OUT_HTML = path.join(__dirname, 'envdoctor.html');

const SENSITIVE_NAME_RE = /API_KEY|SECRET|TOKEN|PASSWORD/i;
const BASH_INVOKE_RE = /(^|[\s"'])bash(\s|"|$)|\.sh(\s|"|$)/i;

// Break-it check hook (see README "Verifying the FAIL path"): normally empty.
// Temporarily push a fake name here (e.g. 'FAKE_TEST_API_KEY') to prove
// check 3 actually fails and exits 1, then revert. Never used to report on
// the real registry — this only feeds a synthetic name into the in-memory
// name list checked by checkScopeEnvVars('User', ...).
const DEBUG_INJECT_USER_NAMES = [];

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Convert a git-bash style path (/c/Users/...) to a native Windows path.
function resolveMsysPath(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

// Walk a hooks object/array and collect every string found under a "command" key.
function collectHookCommands(node, out) {
  out = out || [];
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectHookCommands(n, out));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' && typeof v === 'string') out.push(v);
      else collectHookCommands(v, out);
    }
  }
  return out;
}

// ---- Check 1: .secrets.env presence -----------------------------------

function checkSecretsEnvFile() {
  const id = 1;
  const name = '.secrets.env present';
  let stat;
  try {
    stat = fs.statSync(SECRETS_ENV_PATH);
  } catch (e) {
    return {
      id, name, status: 'WARN',
      summary: `${SECRETS_ENV_PATH} not found.`,
      details: [],
    };
  }
  if (!stat.isFile()) {
    return { id, name, status: 'WARN', summary: `${SECRETS_ENV_PATH} exists but is not a file.`, details: [] };
  }
  const details = [`size: ${stat.size} bytes`, `mtime: ${stat.mtime.toLocaleString()}`];
  if (stat.size === 0) {
    return { id, name, status: 'WARN', summary: '.secrets.env exists but is empty (0 bytes).', details };
  }
  return { id, name, status: 'PASS', summary: '.secrets.env is present and non-empty.', details };
}

// ---- Check 2: BASH_ENV wiring ------------------------------------------

function checkBashEnvWiring() {
  const id = 2;
  const name = 'BASH_ENV wiring';
  const settings = loadJsonSafe(SETTINGS_PATH);
  const settingsLocal = loadJsonSafe(SETTINGS_LOCAL_PATH);

  if (!settings) {
    return { id, name, status: 'WARN', summary: `${SETTINGS_PATH} missing or unreadable; cannot check BASH_ENV wiring.`, details: [] };
  }

  const bashEnvRaw = settings.env && settings.env.BASH_ENV;
  if (!bashEnvRaw) {
    return {
      id, name, status: 'WARN',
      summary: 'BASH_ENV is not set in settings.json "env" block; Bash-tool commands will not auto-load .secrets.env.',
      details: [],
    };
  }

  const resolved = resolveMsysPath(bashEnvRaw);
  let exists = false;
  try { exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile(); } catch (e) { /* leave false */ }

  const details = [
    `BASH_ENV = ${bashEnvRaw}`,
    `resolved path: ${resolved}`,
    `target exists: ${exists}`,
  ];

  if (!exists) {
    return { id, name, status: 'FAIL', summary: `BASH_ENV points at ${resolved}, which does not exist.`, details };
  }

  // The loader script itself (not an .env file) — safe to read for a name-only check.
  let sourcesSecrets = false;
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    sourcesSecrets = text.includes('.secrets.env');
  } catch (e) { /* leave false */ }
  details.push(`target script references .secrets.env by name: ${sourcesSecrets}`);

  const hookCommands = [
    ...collectHookCommands(settings.hooks),
    ...collectHookCommands(settingsLocal && settingsLocal.hooks),
  ];
  const bashInvoking = hookCommands.filter((c) => BASH_INVOKE_RE.test(c));
  details.push(`${hookCommands.length} hook command(s) declared across settings.json / settings.local.json`);

  if (sourcesSecrets && bashInvoking.length > 0) {
    details.push(`bash-invoking hook command(s): ${bashInvoking.join(', ')}`);
    return {
      id, name, status: 'WARN',
      summary: `BASH_ENV sources .secrets.env AND ${bashInvoking.length} hook command(s) look bash-invoking (contain "bash" or ".sh") — this is the $95 leak shape. Verify those hooks don't forward env to an outbound call.`,
      details,
    };
  }

  return {
    id, name, status: 'PASS',
    summary: sourcesSecrets
      ? 'BASH_ENV is wired to a script that sources .secrets.env; no bash-invoking hook commands found in settings files.'
      : 'BASH_ENV target exists but does not reference .secrets.env by name.',
    details,
  };
}

// ---- Checks 3 & 4: Windows env var names by scope -----------------------

function listEnvVarNames(scope) {
  const script = `[Environment]::GetEnvironmentVariables('${scope}').Keys`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) return { error: (res.stderr || '').trim() || `powershell exited ${res.status}` };
  const names = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { names };
}

function checkScopeEnvVars(scope, id, failLevel, injectNames) {
  const name = `${scope}-scope Windows env vars`;
  const result = listEnvVarNames(scope);
  if (result.error) {
    return { id, name, status: 'WARN', summary: `Could not enumerate ${scope}-scope env vars: ${result.error}`, details: [] };
  }
  const names = [...result.names, ...(injectNames || [])];
  const matches = names.filter((n) => SENSITIVE_NAME_RE.test(n));
  const hasAnthropicKey = names.includes('ANTHROPIC_API_KEY');
  const details = [`${names.length} ${scope}-scope var name(s) enumerated (names only, no values read)`];
  if (matches.length > 0) details.push(`matching names: ${matches.join(', ')}`);

  if (matches.length > 0) {
    return {
      id, name, status: failLevel,
      summary: `${matches.length} ${scope}-scope var name(s) match API_KEY|SECRET|TOKEN|PASSWORD${hasAnthropicKey ? ' — includes ANTHROPIC_API_KEY, the $227 incident class' : ''}.`,
      details,
    };
  }
  return { id, name, status: 'PASS', summary: `No ${scope}-scope var names match API_KEY|SECRET|TOKEN|PASSWORD.`, details };
}

// ---- Check 5: current process env sanity --------------------------------

function checkProcessEnv() {
  const has = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
  return {
    id: 5, name: 'Current process env',
    status: 'INFO',
    summary: `ANTHROPIC_API_KEY is ${has ? 'present' : 'absent'} in this process's env (name-presence only, value never read).`,
    details: [],
  };
}

// ---- Check 6: .env hygiene sweep over C:\Projects\<repo>\ ---------------

function checkProjectsEnvHygiene() {
  const id = 6;
  const name = '.env hygiene sweep (C:\\Projects)';

  if (!fs.existsSync(PROJECTS_ROOT)) {
    return { id, name, status: 'WARN', summary: `${PROJECTS_ROOT} not found; skipped.`, details: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return { id, name, status: 'WARN', summary: `Could not list ${PROJECTS_ROOT}: ${e.message}`, details: [] };
  }

  const repos = entries
    .filter((d) => fs.existsSync(path.join(PROJECTS_ROOT, d.name, '.git')))
    .map((d) => d.name);

  const details = [`${entries.length} top-level dir(s) found, ${repos.length} are git repos (have .git)`];
  const okLines = [];
  const warnings = [];
  let reposWithEnv = 0;

  for (const repoName of repos) {
    const repoPath = path.join(PROJECTS_ROOT, repoName); // native Windows path — git -C needs this, not /c/...
    const envPath = path.join(repoPath, '.env');
    let envExists = false;
    try { envExists = fs.statSync(envPath).isFile(); } catch (e) { /* no .env */ }
    if (!envExists) continue;
    reposWithEnv++;

    const examplePath = path.join(repoPath, '.env.example');
    const hasExample = fs.existsSync(examplePath);

    const gitRes = spawnSync('git', ['-C', repoPath, 'check-ignore', '.env'], { encoding: 'utf8' });
    let ignored = null;
    let gitErrorText = null;
    if (gitRes.error) {
      gitErrorText = gitRes.error.message;
    } else if (gitRes.status === 0) {
      ignored = true;
    } else if (gitRes.status === 1) {
      ignored = false;
    } else {
      gitErrorText = (gitRes.stderr || '').trim() || `git exited ${gitRes.status}`;
    }

    if (gitErrorText) {
      warnings.push(`${repoName}: .env present, git check-ignore error: ${gitErrorText}`);
      continue;
    }
    if (!ignored) warnings.push(`${repoName}: .env present but NOT gitignored`);
    if (!hasExample) warnings.push(`${repoName}: .env present but no .env.example`);
    if (ignored && hasExample) okLines.push(`${repoName}: .env present, gitignored, .env.example present — OK`);
  }

  details.push(`${reposWithEnv} repo(s) have a top-level .env`);
  details.push(...okLines);

  if (warnings.length > 0) {
    return {
      id, name, status: 'WARN',
      summary: `${warnings.length} issue(s) found across ${reposWithEnv} repo(s) with a top-level .env.`,
      details: [...details, ...warnings],
    };
  }
  return {
    id, name, status: 'PASS',
    summary: reposWithEnv > 0
      ? `All ${reposWithEnv} repo(s) with a top-level .env are gitignored and have a .env.example.`
      : 'No top-level .env files found in any C:\\Projects repo on this pass.',
    details,
  };
}

// ---- Run + render --------------------------------------------------------

function runChecks() {
  return [
    checkSecretsEnvFile(),
    checkBashEnvWiring(),
    checkScopeEnvVars('User', 3, 'FAIL', DEBUG_INJECT_USER_NAMES),
    checkScopeEnvVars('Machine', 4, 'WARN', []),
    checkProcessEnv(),
    checkProjectsEnvHygiene(),
  ];
}

function printTerminal(results) {
  console.log('envdoctor — env/secrets wiring checkup');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`[${r.status}] ${r.id}. ${r.name}`);
    console.log(`    ${r.summary}`);
    for (const d of r.details) console.log(`    - ${d}`);
  }
  console.log('-'.repeat(60));
  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL, ${counts.INFO} INFO`);
}

function renderHtml(results) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const generatedAt = new Date().toLocaleString();

  const rows = results.map((r) => {
    const statusClass = `status-${r.status.toLowerCase()}`;
    const detailItems = r.details.map((d) => `<li>${htmlEscape(d)}</li>`).join('');
    return `
      <div class="row">
        <div class="cell cell-status"><span class="badge ${statusClass}">${r.status}</span></div>
        <div class="cell cell-body">
          <div class="check-name">${r.id}. ${htmlEscape(r.name)}</div>
          <div class="check-summary">${htmlEscape(r.summary)}</div>
          ${detailItems ? `<ul class="details">${detailItems}</ul>` : ''}
        </div>
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>envdoctor</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink-primary: #ffffff;
    --ink-secondary: #c3c2b7;
    --ink-muted: #898781;
    --border: rgba(255,255,255,0.10);
    --pass: #0ca30c;
    --warn: #d9a72c;
    --fail: #d9422c;
    --info: #4a90d9;
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
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 14px;
    align-items: start;
    background: var(--surface);
    padding: 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child { border-bottom: none; }
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .status-pass { background: rgba(12,163,12,0.18); color: var(--pass); }
  .status-warn { background: rgba(217,167,44,0.18); color: var(--warn); }
  .status-fail { background: rgba(217,66,44,0.18); color: var(--fail); }
  .status-info { background: rgba(74,144,217,0.18); color: var(--info); }
  .check-name { font-weight: 600; margin-bottom: 4px; }
  .check-summary { color: var(--ink-secondary); line-height: 1.4; }
  .details {
    margin: 8px 0 0 0;
    padding-left: 18px;
    color: var(--ink-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  footer { margin-top: 20px; color: var(--ink-muted); font-size: 12px; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
</style>
</head>
<body>
<header>
  <h1>envdoctor — env/secrets wiring checkup</h1>
  <div class="subhead">${counts.PASS} PASS · ${counts.WARN} WARN · ${counts.FAIL} FAIL · ${counts.INFO} INFO · generated ${htmlEscape(generatedAt)}</div>
</header>
<div class="rows">
${rows}
</div>
<footer>
  Read-only. Reports names, presence, and booleans only — never env var values. Re-run <code>node envdoctor.cjs</code> to refresh; this page is a static snapshot.
</footer>
</body>
</html>
`;
}

function generate() {
  const results = runChecks();
  printTerminal(results);
  const html = renderHtml(results);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(OUT_HTML);
  return results;
}

function openFile(filePath) {
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const args = process.argv.slice(2);
  const doOpen = args.includes('--open');

  const results = generate();
  if (doOpen) openFile(OUT_HTML);

  const hasFail = results.some((r) => r.status === 'FAIL');
  process.exit(hasFail ? 1 : 0);
}

main();
