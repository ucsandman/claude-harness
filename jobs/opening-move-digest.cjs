#!/usr/bin/env node
/**
 * jobs/opening-move-digest.cjs — Opening Move step 3: the digest, T0 repairs and the fixture sweep
 * (.agents/memory/2026-11-08-proactive-harness-tournament.md, section 2.5).
 *
 *   node jobs/opening-move-digest.cjs          # scheduled (OpeningMoveDigest, daily 06:50) or a session refresh
 *   node jobs/opening-move-digest.cjs --print  # the same run, then a summary on stdout (the only stdout it ever writes)
 *
 * Writes ~/.claude/state/opening-move/digest.json atomically (tmp + rename):
 *   {ts, from, ms, sources:{doctor,canary,jobs,ci,repos,hookErrors,learning,fixture}, red[], fixed[], ci[], repos[], fixture}
 * Each source is {ok, count, ms, error?}: count is the volume it processed (rule L2). A source that fails
 * keeps the previous digest's rows for that source and records why. Exit 0 always.
 *
 * Red text comes from fixed templates (section 2.5) filled with counts, ages, job names, leg names, doctor
 * ids and file basenames only: never a stack, a path outside the repo, or free text from a log.
 *
 * T0 repairs (REPAIRS): three findings, fixed argv, sync/port read from package.json scripts at run time
 * (each must start with "node "). Preconditions: config.json repair !== false, OPENING_MOVE_REPAIR !== 'off',
 * no ring row under 10 min in this repo's or ~/.claude's opening-move ledger. One attempt per finding per
 * run, two per 24 h; then the finding is red "auto-fix failed twice". Never repaired: guard-class legs,
 * frozen-lock drift, settings.json, test failures (those go to NEXT only).
 *
 * Fixture: 5 planted faults under %LOCALAPPDATA%/opening-move/canary, each ranked by opening-move.rank();
 * below 5 of 5 the brief marks every clean line UNVERIFIED (rule L1).
 *
 * Env: OPENING_MOVE_FROM (session|schedule, default schedule; ci runs only for session),
 * OPENING_MOVE_REPAIR=off. Test seams: OPENING_MOVE_ROOT (package.json, doctor and jobs/install.cjs
 * that repairs read and run), OPENING_MOVE_ONLY (comma list of sources to run), OPENING_MOVE_FIXTURE_DROP
 * (fault names to remove after planting, to watch the sweep miss them).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFile } = require('child_process');

const SELF_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.OPENING_MOVE_ROOT ? path.resolve(process.env.OPENING_MOVE_ROOT) : SELF_ROOT;
const om = require('../engine/hooks/opening-move.cjs');
const install = require('./install.cjs');

const HOME = process.env.USERPROFILE || os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const STATE_DIR = om.STATE_DIR;
const P = {
  digest: path.join(STATE_DIR, 'digest.json'),
  lock: path.join(STATE_DIR, 'digest.lock'),
  ledger: path.join(STATE_DIR, 'ledger.jsonl'),
  config: path.join(STATE_DIR, 'config.json'),
  repos: path.join(STATE_DIR, 'repos'),
  canary: path.join(CLAUDE_HOME, 'guard-canary-status.json'),
  modsLeg: path.join(CLAUDE_HOME, 'mods', 'state', 'canary-leg.json'),
  dispatch: path.join(CLAUDE_HOME, 'state', 'prompt-dispatch.jsonl'),
};
const STORAGE = process.env.AGNOSTIC_STORAGE || path.join(ROOT, 'storage');

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CI_BUDGET_MS = 20e3;
const CI_MAX_REPOS = 15;
const DISTILL_MAX_AGE = 7 * DAY;

const SOURCES = ['doctor', 'canary', 'jobs', 'ci', 'repos', 'hookErrors', 'learning', 'fixture'];
/** A false one of these means a safety guard is not denying: guard-class, shown in every session, never repaired. */
const GUARD_LEGS = ['secret-guard-denies-canary', 'model-guard-denies-modelless', 'gate-freeze-denies-project-edit', 'frozen-guards-match-lock', 'slopsquat-denies-unknown-package', 'hooksPath-set', 'pre-commit-exists', 'hook-targets-exist'];
/**
 * The T0 allowlist: finding -> fixed steps ('scripts.<name>' is read from package.json and must start
 * with "node "; an array is the argv as written) and the check that proves the fix.
 */
const REPAIRS = Object.freeze({
  'rules-drift': Object.freeze({ doctor: 'rules-drift', steps: Object.freeze(['scripts.sync', 'scripts.port']), verify: 'doctor rules-drift ok' }),
  links: Object.freeze({ doctor: 'links', steps: Object.freeze(['scripts.sync']), verify: 'doctor links ok' }),
  'install-differs': Object.freeze({ steps: Object.freeze([Object.freeze(['node', 'jobs/install.cjs', '--apply'])]), verify: 'node jobs/install.cjs prints 0 differ' }),
});
const BANNED_ARG = /^--(force|lock|repin)\b/;
const GH_RE = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;
// Control, line-separator and bidi characters, built from code points so no raw separator sits in the source.
const NOTE_CTRL_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']+', 'g');

// --- helpers: every read returns a default instead of throwing ---

function readJson(p, dflt = null) { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : dflt; } catch (_) { return dflt; } }
function writeJsonAtomic(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, p);
}
function appendLine(p, row) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(row) + '\n'); } catch (_) {} }
function tail(p, bytes) {
  let fd;
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - bytes);
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch (_) { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}
function jsonl(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch (_) {} }
  return out;
}
const iso = (ms) => new Date(ms).toISOString();
const sha12 = (kind, stable) => crypto.createHash('sha1').update(`${kind}\u0000${stable}`).digest('hex').slice(0, 12);
/** A name from a state file key (leg, job, doctor id): letters, digits, space, . _ - only. */
const nameOf = (s, max = 60) => String(s == null ? '' : s).replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, max);
/** One line, home path shortened to ~, capped: for source errors (never shown as red text). */
function oneLine(s, max = 120) {
  const home = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(s == null ? '' : s).replace(new RegExp(home, 'gi'), '~').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/**
 * A Mods leg's note as derived text only, never the note itself (mods/canary.cjs stores raw command output,
 * stacks and failure text there): validate-* gives the count of its JSON error list, tests its pass/fail
 * counts, version its installed and pinned versions; any other leg points at canary-leg.json.
 */
function noteText(note, leg) {
  let t = String(note == null ? '' : note);
  if (t.split(':')[0].trim() === leg) t = t.slice(t.indexOf(':') + 1);
  t = t.replace(NOTE_CTRL_RE, ' ').trim();
  if (/^validate-/.test(leg)) {
    if (!t.startsWith('[')) return 'no json';
    try { const a = JSON.parse(t); return Array.isArray(a) ? `${a.length} errors listed` : 'no json'; } catch (_) { return 'error list truncated'; }
  }
  if (leg === 'tests') return /^pass=\d+ fail=\d+$/.test(t) ? t : 'see canary-leg.json';
  if (leg === 'version') { const m = /^installed [\d.]+ (?:==|vs) pinned [\d.]+/.exec(t); return m ? m[0] : 'see canary-leg.json'; }
  return 'see canary-leg.json';
}
function item(kind, text, stable, { ageMs = 0, guardClass = false, source } = {}) {
  return { kind, text, hash: sha12(kind, stable), ageMs: Math.max(0, Math.round(ageMs || 0)), guardClass: !!guardClass, source };
}
function execP(cmd, args, timeout, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 << 20, ...opts }, (err, stdout) => {
        if (!err) return resolve({ ok: true, out: String(stdout || '') });
        resolve({ ok: false, enoent: err.code === 'ENOENT', timedOut: !!(err.killed || err.signal), code: err.code });
      });
    } catch (_) { resolve({ ok: false }); }
  });
}

// --- job contracts (shared by the jobs source and fixture fault 3) ---

/**
 * Red items for every contract that is not fresh, and for a fresh one whose task last failed: three artifacts
 * (port-daily.log, harvest.log, daily-distill.log) are written when a run starts, so a job that fails daily
 * keeps its contract fresh. tasks: {name: {state, lastResult}} from Task Scheduler.
 */
const RESULT_QUIET = [0, 267009, 267011]; // ok, running, not yet run
function jobReds(rows, tasks) {
  const out = [];
  for (const c of rows) {
    const t = tasks && tasks[c.name];
    if (c.state === 'fresh') {
      const lr = t && t.state === 'registered' && t.lastResult != null ? Number(t.lastResult) : 0;
      if (!Number.isFinite(lr) || RESULT_QUIET.includes(lr)) continue;
      const name = nameOf(c.name);
      const why = c.resultNote && c.resultNote[lr] ? nameOf(c.resultNote[lr], 60) : 'artifact fresh';
      out.push(item('job-stale', `${name}: last result ${lr} (${why}).`, `${name}|result|${lr}`, { source: 'jobs' }));
      continue;
    }
    const code = !t ? 'unknown' : t.state !== 'registered' ? 'not registered' : t.lastResult == null ? 'none' : Number(t.lastResult) === 267011 ? 'not yet run' : String(Number(t.lastResult));
    const name = nameOf(c.name);
    const file = nameOf(path.basename(String(c.file || c.path || '')), 80);
    const text = c.state === 'missing'
      ? `${name}: ${file} missing (limit ${Number(c.maxAgeH)} h), last result ${code}.`
      : `${name}: ${file} ${Math.floor(c.ageMs / DAY)} d old (limit ${Number(c.maxAgeH)} h), last result ${code}.`;
    out.push(item('job-stale', text, `${name}|${file}|${c.state}|${c.maxAgeH}|${code}`, { ageMs: c.ageMs || 0, source: 'jobs' }));
  }
  return out;
}

// --- ci parser (shared by the ci source and fixture fault 5) ---

/** gh run list --json output -> digest ci rows, each stamped fetchedAt (the brief ignores rows over 60 min old). meta: {slug, key, branch}. */
function parseCi(json, meta, now = Date.now()) {
  let arr;
  try { arr = JSON.parse(String(json || '')); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((r) => r && typeof r === 'object').map((r) => ({
    repo: String(meta.slug || '').replace(/[^A-Za-z0-9_./-]/g, '').slice(0, 100),
    key: String(meta.key || ''),
    branch: String(meta.branch || '').replace(/[^A-Za-z0-9_./-]/g, '').slice(0, 80),
    sha: /^[0-9a-f]{7,40}$/i.test(String(r.headSha || '')) ? String(r.headSha) : '',
    conclusion: r.conclusion ? nameOf(r.conclusion, 20) : null,
    status: r.status ? nameOf(r.status, 20) : null,
    workflow: nameOf(r.workflowName, 60),
    runId: Number(r.databaseId) || 0,
    createdAt: Number.isFinite(Date.parse(r.createdAt)) ? iso(Date.parse(r.createdAt)) : null,
    fetchedAt: iso(now),
  }));
}
/** A ci run's rows: the fresh ones, plus the previous rows of the repos whose gh call failed (never all old rows, never none). */
function mergeCi(prev, fresh, failedKeys) {
  const failed = new Set(failedKeys || []);
  return [...(fresh || []), ...(Array.isArray(prev) ? prev : []).filter((p) => p && failed.has(p.key))];
}

// --- sources ---

function doctorRun() {
  // The real doctor's rules-drift check runs `port --check`, which captures the Claude home into this
  // repository's harness/. In a home with no Claude settings that capture would be of nothing.
  if (ROOT === SELF_ROOT && !fs.existsSync(path.join(os.homedir(), '.claude', 'settings.json'))) throw new Error('no .claude/settings.json in this home: doctor not run');
  return require(path.join(ROOT, 'engine', 'doctor', 'doctor.cjs')).run();
}

function srcDoctor(ctx) {
  ctx.doctor = doctorRun();
  const failed = ctx.doctor.filter((r) => !r.ok).length;
  return { count: ctx.doctor.length, failed };
}

function srcCanary(ctx) {
  const st = readJson(P.canary);
  const leg = readJson(P.modsLeg);
  if (!st && !leg) throw new Error('guard-canary-status.json and canary-leg.json both absent');
  const red = [];
  let count = 0;
  const gAge = st && Date.parse(st.ranAt) ? ctx.now - Date.parse(st.ranAt) : 0;
  const mAge = leg && Date.parse(leg.ranAt) ? ctx.now - Date.parse(leg.ranAt) : 0;
  const gres = (st && st.results) || {};
  for (const [k, v] of Object.entries(gres)) {
    count++;
    if (v !== false || !GUARD_LEGS.includes(k)) continue;
    red.push(item('guard-leg', `GUARD ${nameOf(k)} is not denying: do not trust guarded operations; fix from an agnostic-ai session.`, k, { ageMs: gAge, guardClass: true, source: 'canary' }));
  }
  const mres = (leg && leg.results) || {};
  const notes = Array.isArray(leg && leg.notes) ? leg.notes : [];
  let modsFalse = 0;
  for (const [k, v] of Object.entries(mres)) {
    count++;
    if (v !== false) continue;
    modsFalse++;
    const l = nameOf(k);
    const note = notes.find((n) => String(n).split(':')[0].trim() === k);
    const nt = note ? noteText(note, k) : 'no note';
    // The evidence is the leg (and the pinned version for version): a note's ages and counts change every run.
    const pin = k === 'version' ? (/pinned ([\d.]+)/.exec(nt) || [])[1] : '';
    red.push(item('mods-leg', `Mods canary leg ${l} false (${nt}); --repin is refused while any leg is red. Diagnose ${l}, then node ~\\.claude\\mods\\canary.cjs until all legs ok.`, pin ? `${l}|${pin}` : l, { ageMs: mAge, source: 'canary' }));
  }
  if (gres['mods-layer-healthy'] === false && !modsFalse) {
    red.push(item('mods-leg', 'Mods canary leg mods-layer-healthy false (no false leg in canary-leg.json); --repin is refused while any leg is red. Diagnose mods-layer-healthy, then node ~\\.claude\\mods\\canary.cjs until all legs ok.', 'mods-layer-healthy', { ageMs: gAge, source: 'canary' }));
  }
  return { count, red, guardFalse: red.filter((r) => r.guardClass).length, modsFalse };
}

function scheduledTasks(names) {
  const q = names.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
  const script = `$rows = foreach ($n in @(${q})) { $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue | Select-Object -First 1; if ($t) { $i = $t | Get-ScheduledTaskInfo; $a = $t.Actions[0]; $lr = $null; if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $lr = $i.LastRunTime.ToUniversalTime().ToString('o') }; [pscustomobject]@{ name = $n; state = 'registered'; lastResult = $i.LastTaskResult; lastRun = $lr; execute = $a.Execute; args = $a.Arguments; wd = $a.WorkingDirectory } } else { [pscustomobject]@{ name = $n; state = 'missing'; lastResult = $null; lastRun = $null } } }; ConvertTo-Json -InputObject @($rows) -Compress`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60e3 });
  if (r.status !== 0) throw new Error(`Get-ScheduledTask exit ${r.status}`);
  let arr;
  try { arr = JSON.parse(String(r.stdout || '').trim()); } catch (_) { throw new Error('Get-ScheduledTask output is not JSON'); }
  const tasks = {};
  for (const t of Array.isArray(arr) ? arr : [arr]) {
    if (!t || !t.name) continue;
    tasks[t.name] = { state: t.state, lastResult: t.lastResult == null ? null : Number(t.lastResult), lastRun: t.lastRun || null };
    if (t.state === 'registered') tasks[t.name].differs = install.differs(t.name, { execute: t.execute, args: t.args, wd: t.wd }) === true;
  }
  return tasks;
}

function installCheck() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'jobs', 'install.cjs')], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180e3 });
  const m = /(\d+) differ/.exec(String(r.stdout || ''));
  if (!m) return { ok: false, error: `install.cjs exit ${r.status}, no "differ" count` };
  const miss = /(\d+) missing/.exec(String(r.stdout || ''));
  return { ok: true, differ: Number(m[1]), missing: miss ? Number(miss[1]) : 0 };
}

function srcJobs(ctx) {
  if (process.platform !== 'win32') return { count: 0, known: 0, red: [], note: 'not windows' };
  const names = install.knownJobs();
  const tasks = scheduledTasks(names);
  ctx.tasks = tasks;
  const rows = install.contractStatus({ now: ctx.now, home: HOME });
  // This run's own contract (digest.json) is judged by doctor `jobs` and the brief's digest age, not by itself.
  const red = jobReds(rows.filter((c) => c.name !== 'OpeningMoveDigest'), tasks);
  const differ = names.filter((n) => tasks[n] && tasks[n].differs).length;
  ctx.install = { ok: true, differ };
  const registered = names.filter((n) => tasks[n] && tasks[n].state === 'registered').length;
  return {
    count: names.length, known: names.length, registered, withContract: rows.length, fresh: rows.filter((c) => c.state === 'fresh').length,
    noContract: names.length - rows.length, differ, red,
  };
}

function srcRepos(ctx) {
  const radar = require('../tools/gitradar/gitradar.cjs');
  const all = radar.scanAll();
  ctx.reposAll = all;
  const weight = (r) => (r.error ? 0 : (r.dirtyCount || 0) + (r.unpushedCount || 0) + (r.goneCount || 0));
  const sorted = all.slice().sort((a, b) => radar.severity(b) - radar.severity(a) || weight(b) - weight(a) || String(a.name).localeCompare(String(b.name)));
  const rows = sorted.slice(0, 10).map((r) => ({
    name: r.name, repoPath: r.repoPath, key: om.repoKey(r.repoPath), severity: radar.severity(r), error: !!r.error,
    ...(r.error ? { errorCmd: r.errorCmd } : { branch: r.branch, dirtyCount: r.dirtyCount, unpushedCount: r.unpushedCount, goneCount: r.goneCount, noUpstream: r.noUpstream, lastCommitMs: r.lastCommitMs }),
  }));
  return { count: all.length, errors: all.filter((r) => r.error).length, rows };
}

async function srcCi(ctx) {
  // Skipped is not ok: no gh call ran (L2). The previous rows stay, each with its own fetchedAt.
  if (ctx.from !== 'session') return { ok: false, count: 0, skipped: 'scheduled, no session env', kept: (ctx.prev.ci || []).length };
  if (!Array.isArray(ctx.reposAll)) throw new Error('repos source did not run');
  const t0 = Date.now();
  const recent = ctx.reposAll.filter((r) => !r.error && r.lastCommitMs && ctx.now - r.lastCommitMs < 14 * DAY).sort((a, b) => b.lastCommitMs - a.lastCommitMs).slice(0, CI_MAX_REPOS);
  const targets = [];
  for (const r of recent) {
    const u = spawnSync('git', ['-C', r.repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = u.status === 0 ? GH_RE.exec(String(u.stdout || '').trim()) : null;
    if (m) targets.push({ slug: `${m[1]}/${m[2]}`, key: om.repoKey(r.repoPath), branch: r.branch });
  }
  const N = targets.length;
  const auth = await execP('gh', ['auth', 'status'], 8000);
  if (!auth.ok) return { ok: false, count: 0, of: N, error: auth.enoent ? 'no auth (gh not found)' : 'no auth', summary: `ci: 0 of ${N} (no auth)` };
  const deadline = t0 + CI_BUDGET_MS;
  const res = await Promise.all(targets.map((t) => execP('gh', ['run', 'list', '-R', t.slug, '-b', t.branch, '-L', '1', '--json', 'conclusion,status,headSha,workflowName,databaseId,createdAt'], Math.max(1000, deadline - Date.now()))));
  const fresh = [];
  const failedKeys = [];
  res.forEach((r, i) => { if (r.ok) fresh.push(...parseCi(r.out, targets[i], Date.now())); else failedKeys.push(targets[i].key); });
  const fails = failedKeys.length;
  // Every call failed: no rows returned, so digest() keeps the previous rows whole.
  const rows = fails < N || !N ? mergeCi(ctx.prev.ci, fresh, failedKeys) : undefined;
  return { ok: fails === 0, count: fresh.length, of: N, rows, ...(fails ? { error: `${fails} of ${N} gh calls failed or timed out` } : {}) };
}

function srcHookErrors(ctx) {
  // Absent means the dispatcher is not writing, not that no hook failed (L2).
  if (!fs.existsSync(P.dispatch)) throw new Error('prompt-dispatch.jsonl absent');
  const rows = jsonl(tail(P.dispatch, 2 << 20)).filter((r) => ctx.now - Date.parse(r.ts) < DAY);
  const bad = rows.filter((r) => r.errors && typeof r.errors === 'object' && Object.keys(r.errors).length);
  const names = [...new Set(bad.flatMap((r) => Object.keys(r.errors)).map((n) => nameOf(n)))].slice(0, 5);
  return { count: rows.length, errors: bad.length, hooks: names };
}

function srcLearning(ctx) {
  const f = path.join(STORAGE, 'distill-PROPOSAL.md');
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(f).mtimeMs; } catch (_) {}
  const reg = ctx.tasks ? (ctx.tasks.DailyDistill && ctx.tasks.DailyDistill.state === 'registered' ? 'registered' : 'missing') : 'unknown';
  const red = [];
  const age = mtimeMs == null ? null : ctx.now - mtimeMs;
  if (age == null || age > DISTILL_MAX_AGE || reg === 'missing') {
    const what = age == null ? 'proposal missing' : `proposal ${Math.floor(age / DAY)} d old`;
    red.push(item('distill', `distill: ${what}; DailyDistill ${reg}.`, `${age == null ? 'missing' : 'old'}|${reg}`, { ageMs: age || 0, source: 'learning' }));
  }
  return { count: 1, proposalAgeDays: age == null ? null : Math.floor(age / DAY), dailyDistill: reg, red };
}

/** Five planted faults, each ranked by opening-move.rank(). drop: fault names removed after planting (L1 seam). */
function sweepFixture({ base, drop, now = Date.now() } = {}) {
  base = base || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'opening-move', 'canary');
  const dropped = new Set(String(drop || '').split(',').map((s) => s.trim()).filter(Boolean));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  const hooks = path.join(base, 'no-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const g = (cwd, args) => {
    const r = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', '-c', 'user.email=fixture@opening-move.invalid', '-c', 'user.name=opening-move fixture', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) throw new Error(`git ${args[0]} exit ${r.status}`);
    return String(r.stdout || '').trim();
  };
  const mkRepo = (name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    g(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
    g(dir, ['add', 'README.md']);
    g(dir, ['commit', '-q', '-m', 'fixture']);
    return dir;
  };
  const repo = (top) => ({ top, name: path.basename(top), branch: 'main', head: 'f1x7e00', isAgnostic: false, isHarness: true, deploysOnPush: false });
  /** The state the brief builds, from real git calls in a fixture repo. */
  const stateOf = (dir) => {
    const dirty = g(dir, ['status', '--porcelain=v1']).split('\n').filter((l) => l.length > 3).map((l) => {
      const p = l.slice(3);
      let m = null;
      try { m = fs.statSync(path.join(dir, p)).mtimeMs; } catch (_) {}
      return { path: p, mtimeMs: m };
    });
    let ahead;
    try { ahead = { ok: true, n: parseInt(g(dir, ['rev-list', '--count', '@{u}..HEAD']), 10) || 0 }; } catch (_) { ahead = { ok: false, why: 'no upstream' }; }
    return { now, repo: repo(dir), git: { status: { ok: true, dirty }, ahead }, markers: { tasks: [] } };
  };
  const clean = { now, repo: repo(base), git: { status: { ok: true, dirty: [] }, ahead: { ok: true, n: 0 } }, markers: { tasks: [] } };
  const faults = [];
  const check = (name, fn) => { try { faults.push({ name, found: !!fn() }); } catch (e) { faults.push({ name, found: false, error: oneLine(e.message, 80) }); } };

  check('stale-dirty', () => {
    const d = mkRepo('stale-dirty');
    const f = path.join(d, 'left-behind.txt');
    fs.writeFileSync(f, 'x\n');
    const t = (now - 8 * DAY) / 1000;
    fs.utimesSync(f, t, t);
    if (dropped.has('stale-dirty')) fs.unlinkSync(f);
    const r = om.rank(stateOf(d));
    return r && r.next && r.next.kind === 'stale-dirty';
  });
  check('unpushed-clean', () => {
    const d = mkRepo('unpushed');
    const bare = path.join(base, 'unpushed.git');
    g(base, ['init', '-q', '--bare', bare]);
    g(d, ['remote', 'add', 'origin', bare]);
    g(d, ['push', '-q', '-u', 'origin', 'main']);
    if (!dropped.has('unpushed-clean')) {
      fs.writeFileSync(path.join(d, 'ahead.txt'), 'x\n');
      g(d, ['add', 'ahead.txt']);
      g(d, ['commit', '-q', '-m', 'ahead']);
    }
    const r = om.rank(stateOf(d));
    return r && r.next && r.next.kind === 'unpushed-clean' && /^Push 1 commit on main\b/.test(r.next.text);
  });
  check('job-stale', () => {
    const f = path.join(base, 'job', 'fixture-job.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'ran\n');
    const t = (now - 3 * DAY) / 1000;
    if (!dropped.has('job-stale')) fs.utimesSync(f, t, t);
    const rows = install.contractStatus({ now, list: [{ name: 'FixtureJob', path: '<fixture>/fixture-job.log', file: f, maxAgeH: 26 }] });
    const reds = jobReds(rows, { FixtureJob: { state: 'registered', lastResult: 0 } });
    const r = om.rank({ ...clean, digest: { red: reds } });
    return r && r.next && r.next.kind === 'harness-red' && r.next.text === 'FixtureJob: fixture-job.log 3 d old (limit 26 h), last result 0.';
  });
  check('hard-stop', () => {
    const text = dropped.has('hard-stop') ? 'tidy the app' : 'deploy the app';
    const r = om.rank({ ...clean, next: { text, owner: 'me', ts: iso(now - HOUR) } });
    const you = r && r.leftForWes && r.leftForWes[0];
    return r && !r.next && you && you.owner === 'you' && you.text === 'prepare deploy the app; deploy the app stays yours';
  });
  check('ci-red', () => {
    const run = { conclusion: dropped.has('ci-red') ? 'success' : 'failure', status: 'completed', headSha: 'f'.repeat(40), workflowName: 'ci.yml', databaseId: 42, createdAt: iso(now - HOUR) };
    const rows = parseCi(JSON.stringify([run]), { slug: 'fixture/canary', key: 'fixture', branch: 'main' });
    const r = om.rank({ ...clean, ci: rows });
    return r && r.next && r.next.kind === 'ci-red' && /^CI failed on main at fffffff \(ci\.yml, run 42,/.test(r.next.text);
  });
  const found = faults.filter((f) => f.found).length;
  return { found, of: 5, missed: faults.filter((f) => !f.found).map((f) => f.name) };
}

function srcFixture(ctx) {
  ctx.fixture = sweepFixture({ drop: process.env.OPENING_MOVE_FIXTURE_DROP, now: ctx.now });
  const red = ctx.fixture.found < ctx.fixture.of ? [item('fixture', `opening-move fixture missed ${ctx.fixture.missed.map((n) => nameOf(n)).join(', ')}.`, ctx.fixture.missed.join('|'), { source: 'fixture' })] : [];
  return { count: ctx.fixture.of, found: ctx.fixture.found, red };
}

// --- T0 repairs ---

function scriptArgv(step) {
  const name = String(step).replace(/^scripts\./, '');
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  const s = pkg && pkg.scripts && pkg.scripts[name];
  if (typeof s !== 'string' || !s.startsWith('node ')) return { refused: `scripts.${name} does not start with "node "` };
  const argv = s.trim().split(/\s+/);
  if (argv.some((a) => /[;&|<>`$()]/.test(a) || BANNED_ARG.test(a))) return { refused: `scripts.${name} carries a shell operator or a banned flag` };
  return { argv };
}

function runArgv(argv) {
  if (argv[0] !== 'node' || argv.some((a) => BANNED_ARG.test(a))) return { ok: false, code: 'refused' };
  const r = spawnSync(process.execPath, argv.slice(1), { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10 * MIN, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, code: r.status };
}

/**
 * A repo ledger's newest sign of a live session: a ring row's prompt ts, its stopTs, its transcript's mtime
 * (appended all through a turn, so a long turn stays live), or the last SessionStart brief (written before
 * the session's first prompt). 0 when there is none.
 */
function lastSignOfLife(rs) {
  let t = 0;
  for (const r of Array.isArray(rs && rs.ring) ? rs.ring : []) {
    if (!r || typeof r !== 'object') continue;
    t = Math.max(t, Date.parse(r.ts) || 0, Date.parse(r.stopTs) || 0);
    if (r.transcript_path) { try { t = Math.max(t, fs.statSync(String(r.transcript_path)).mtimeMs); } catch (_) {} }
  }
  if (rs && rs.lastBrief) t = Math.max(t, Date.parse(rs.lastBrief.ts) || 0);
  return t;
}

/** Preconditions: the repair toggle, the env kill switch, and no live session in this repo or ~/.claude. */
function repairGate(now, from = 'schedule') {
  // A home that is not this machine's harness home (a test's temp USERPROFILE) must never drive a repair of
  // this repository or of Task Scheduler: install.cjs builds its wanted actions from the home it runs under.
  if (ROOT === SELF_ROOT && !fs.existsSync(path.join(HOME, '.claude', 'settings.json'))) return { ok: false, why: 'not a harness home (no .claude/settings.json)' };
  const cfg = readJson(P.config, {});
  if (cfg && cfg.repair === false) return { ok: false, why: 'config.json repair: false' };
  if (String(process.env.OPENING_MOVE_REPAIR || '').toLowerCase() === 'off') return { ok: false, why: 'OPENING_MOVE_REPAIR=off' };
  const tops = [ROOT, CLAUDE_HOME];
  if (from === 'session') {
    // A session refresh runs while the session that spawned it starts up: never under a harness session.
    const sp = process.env.OPENING_MOVE_SPAWNER;
    if (sp === undefined) return { ok: false, why: 'a session refresh that names no spawner' };
    const at = tops.find((top) => om.repoKey(top) === sp);
    if (at) return { ok: false, why: `spawned by a session in ${nameOf(path.basename(at))}` };
  }
  for (const top of tops) {
    const t = lastSignOfLife(readJson(path.join(P.repos, om.repoKey(top) + '.json'), {}));
    if (t && now - t < 10 * MIN) return { ok: false, why: `a session is live in ${nameOf(path.basename(top))} (last sign ${Math.max(0, Math.round((now - t) / 1000))} s ago)` };
  }
  return { ok: true };
}

/** Rewrite digest.lock's ts while this process holds it, so a long repair is never taken for a dead run. */
function touchLock() {
  const l = readJson(P.lock, null);
  if (l && Number(l.pid) === process.pid) { try { writeJsonAtomic(P.lock, { pid: process.pid, ts: iso(Date.now()) }); } catch (_) {} }
}

/** A failing doctor check's size: the counts its lines name, else 1 (links: one line per bad link). */
function countOf(r) {
  if (!r || r.ok) return 0;
  let n = 0;
  for (const m of (r.lines || []).join('\n').matchAll(/(\d+) (?:would change|would write|would update|stale|changed|differ)/g)) n += Number(m[1]);
  return n || (r.id === 'links' ? (r.lines || []).length || 1 : 1);
}

function runRepairs(ctx) {
  const out = { fixed: [], status: {}, gate: null, attempted: 0 };
  const found = [];
  for (const id of ['rules-drift', 'links']) { const r = (ctx.doctor || []).find((x) => x.id === id); if (r && !r.ok) found.push({ finding: id, before: countOf(r) }); }
  if (ctx.install && ctx.install.ok && ctx.install.differ > 0) found.push({ finding: 'install-differs', before: ctx.install.differ });
  if (!found.length) return out;
  out.gate = repairGate(ctx.now, ctx.from);
  const rows = jsonl(tail(P.ledger, 1 << 20));
  for (const f of found) {
    if (!out.gate.ok) { out.status[f.finding] = 'no auto-fix'; continue; }
    if (REPAIRS[f.finding].doctor) {
      const cur = ctx.doctor.find((x) => x.id === f.finding);
      if (cur && cur.ok) { out.status[f.finding] = 'fixed'; out.fixed.push({ finding: f.finding, action: 'fixed by the repair before it', before: f.before, after: 0, ok: true, ts: iso(Date.now()) }); continue; }
    }
    const n24 = rows.filter((r) => r.finding === f.finding && (r.outcome === 'auto-fixed' || r.outcome === 'auto-fix-failed') && ctx.now - Date.parse(r.ts) < DAY).length;
    if (n24 >= 2) { out.status[f.finding] = 'auto-fix failed twice'; continue; }
    out.attempted++;
    const steps = [];
    let refused = null;
    for (const s of REPAIRS[f.finding].steps) {
      const a = Array.isArray(s) ? { argv: s.slice() } : scriptArgv(s);
      if (a.refused) { refused = a.refused; break; }
      steps.push(a.argv);
    }
    let after = f.before;
    let ok = false;
    let failedAt = null;
    if (!refused) {
      for (const argv of steps) { touchLock(); const r = runArgv(argv); if (!r.ok) { failedAt = `${argv.join(' ')} exit ${r.code}`; break; } }
      touchLock();
      if (REPAIRS[f.finding].doctor) {
        try { ctx.doctor = doctorRun(); } catch (_) {}
        const r = (ctx.doctor || []).find((x) => x.id === f.finding);
        after = r ? countOf(r) : f.before;
        ok = !failedAt && !!(r && r.ok);
      } else {
        const v = installCheck();
        if (v.ok) ctx.install = v;
        after = v.ok ? v.differ : f.before;
        ok = !failedAt && v.ok && v.differ === 0;
      }
    }
    const action = refused ? `refused: ${refused}` : steps.map((a) => a.join(' ')).join(' && ') + (failedAt ? ` (${failedAt})` : '');
    const ts = iso(Date.now());
    out.fixed.push({ finding: f.finding, action, before: f.before, after, ok, ts });
    appendLine(P.ledger, { ts, repo: om.repoKey(ROOT), kind: f.finding, hash: sha12('auto-fix', f.finding), outcome: ok ? 'auto-fixed' : 'auto-fix-failed', finding: f.finding, action, before: f.before, after, ...(refused ? { refused: true } : {}) });
    out.status[f.finding] = ok ? 'fixed' : 'after auto-fix';
  }
  return out;
}

/** Doctor and install reds after the repairs ran. The jobs check is the jobs source's (its reds name the job). */
function repairReds(ctx, rep) {
  const red = [];
  const how = (id) => {
    const s = rep.status[id];
    if (s === 'auto-fix failed twice') return 'after auto-fix (auto-fix failed twice in 24 h)';
    if (s === 'after auto-fix') return 'after auto-fix';
    return 'no auto-fix';
  };
  for (const r of ctx.doctor || []) {
    if (r.ok || r.id === 'jobs') continue;
    const id = nameOf(r.id);
    red.push(item('doctor', `doctor ${id} FAIL ${how(r.id)}: npm run doctor, fix ${id}.`, `${id}|${how(r.id)}`, { source: 'doctor' }));
  }
  if (ctx.install && ctx.install.ok && ctx.install.differ > 0) {
    const n = ctx.install.differ;
    red.push(item('install', `install: ${n} jobs differ ${how('install-differs')}: node jobs/install.cjs, then re-point them.`, `${n}|${how('install-differs')}`, { source: 'jobs' }));
  }
  return red;
}

// --- the run ---

async function digest() {
  const t0 = Date.now();
  const from = String(process.env.OPENING_MOVE_FROM || 'schedule').toLowerCase() === 'session' ? 'session' : 'schedule';
  const only = process.env.OPENING_MOVE_ONLY ? new Set(String(process.env.OPENING_MOVE_ONLY).split(',').map((s) => s.trim())) : null;
  const prev = readJson(P.digest, {}) || {};
  const ctx = { now: t0, from, prev };
  const sources = {};
  const red = [];
  // The fixture verdict is never carried over: a sweep that did not run this time is "0 of 5, not run" (L1).
  const keep = { ci: Array.isArray(prev.ci) ? prev.ci : [], repos: Array.isArray(prev.repos) ? prev.repos : [], fixture: null };
  const prevRed = (name) => (Array.isArray(prev.red) ? prev.red : []).filter((x) => x && x.source === name);
  const fns = { doctor: srcDoctor, canary: srcCanary, jobs: srcJobs, repos: srcRepos, ci: srcCi, hookErrors: srcHookErrors, learning: srcLearning, fixture: srcFixture };
  const kept = {};
  for (const name of ['doctor', 'canary', 'jobs', 'repos', 'ci', 'hookErrors', 'learning', 'fixture']) {
    const s = Date.now();
    if (only && !only.has(name)) {
      sources[name] = { ok: false, count: 0, ms: 0, error: 'not run (OPENING_MOVE_ONLY)' };
      kept[name] = true;
      if (name !== 'doctor') red.push(...prevRed(name)); // doctor rows are settled after the repairs
      continue;
    }
    try {
      const r = (await fns[name](ctx)) || {};
      const { red: rr, rows, ok, error, ...extra } = r;
      sources[name] = { ok: ok !== false, count: Number(r.count) || 0, ms: Date.now() - s, ...extra, ...(error ? { error: oneLine(error) } : {}) };
      if (Array.isArray(rr)) red.push(...rr);
      if (name === 'ci' && Array.isArray(rows)) keep.ci = rows; // srcCi merges by repo; no rows means every call failed
      if (name === 'repos') keep.repos = rows || [];
      if (name === 'fixture') keep.fixture = ctx.fixture;
      if (ok === false) kept[name] = true;
    } catch (e) {
      sources[name] = { ok: false, count: 0, ms: Date.now() - s, error: oneLine(e && e.message) };
      kept[name] = true;
      if (name !== 'doctor') red.push(...prevRed(name));
    }
  }
  const rep = runRepairs(ctx);
  if (ctx.doctor) red.push(...repairReds(ctx, rep));
  else if (kept.doctor) red.push(...prevRed('doctor'));
  if (sources.doctor && ctx.doctor) sources.doctor.failed = ctx.doctor.filter((r) => !r.ok).length;
  const order = ['guard-leg', 'doctor', 'install', 'mods-leg', 'job-stale', 'distill', 'fixture'];
  red.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const out = {
    ts: iso(t0), from, ms: Date.now() - t0, sources, red, fixed: rep.fixed,
    ...(rep.gate && !rep.gate.ok ? { repair: { skipped: rep.gate.why } } : {}),
    ci: keep.ci, repos: keep.repos,
    fixture: keep.fixture || { found: 0, of: 5, missed: ['not run'], ...(sources.fixture && sources.fixture.error ? { error: sources.fixture.error } : {}) },
  };
  writeJsonAtomic(P.digest, out);
  return out;
}

function summary(d) {
  const okN = SOURCES.filter((n) => d.sources[n] && d.sources[n].ok).length;
  const lines = [`opening-move digest: ${okN} of ${SOURCES.length} sources in ${(d.ms / 1000).toFixed(1)} s (from ${d.from}); wrote ${P.digest.replace(HOME, '~')}`];
  for (const n of SOURCES) {
    const s = d.sources[n] || {};
    const extra = Object.entries(s).filter(([k, v]) => !['ok', 'count', 'ms', 'error'].includes(k) && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' ');
    lines.push(`  ${n.padEnd(11)} ${s.ok ? 'ok  ' : s.skipped ? 'skip' : 'FAIL'} count=${s.count} ${s.ms} ms${extra ? ' ' + extra : ''}${s.error ? ` error: ${s.error}` : ''}`);
  }
  lines.push(`red: ${d.red.length} (${d.red.filter((r) => r.guardClass).length} guard-class)`);
  for (const r of d.red) lines.push(`  [${r.kind}${r.guardClass ? ', guard' : ''}] ${r.text}`);
  lines.push(`fixed: ${d.fixed.filter((f) => f.ok).length} of ${d.fixed.length} attempted${d.repair ? ` (repair skipped: ${d.repair.skipped})` : ''}`);
  for (const f of d.fixed) lines.push(`  ${f.ok ? 'fixed' : 'FAILED'} ${f.finding}: ${f.action} (before ${f.before}, after ${f.after})`);
  lines.push(`ci rows: ${d.ci.length}; repos: ${d.repos.length} of ${(d.sources.repos || {}).count || 0} kept (worst first)`);
  lines.push(`fixture ${d.fixture.found} of ${d.fixture.of}${d.fixture.missed.length ? ` (missed ${d.fixture.missed.join(', ')})` : ''}`);
  return lines.join('\n');
}

/**
 * digest.lock for this run, by the brief's protocol (opening-move.cjs lockState/takeLock). A session child
 * adopts the lock its brief took (the brief's pid is this process's parent, then the brief rewrites it to
 * this pid); any run takes an absent or stale lock; a live holder means another run is going: false.
 */
function acquireLock(from) {
  const cur = om.lockState();
  if (from === 'session' && cur && (cur.pid === process.pid || cur.pid === process.ppid)) {
    try { writeJsonAtomic(P.lock, { pid: process.pid, ts: iso(Date.now()) }); return true; } catch (_) { return false; }
  }
  return om.takeLock(process.pid);
}
/** Remove digest.lock only while it is this run's: never another run's lock. */
function releaseLock() {
  const l = readJson(P.lock, null);
  if (l && Number(l.pid) === process.pid) { try { fs.unlinkSync(P.lock); } catch (_) {} }
}

if (require.main === module) {
  process.noDeprecation = true; // the in-process doctor's deps probe warns on stderr; this job writes nothing it was not asked for
  const print = process.argv.includes('--print');
  const from = String(process.env.OPENING_MOVE_FROM || '').toLowerCase() === 'session' ? 'session' : 'schedule';
  if (!acquireLock(from)) {
    if (print) process.stdout.write('opening-move digest: another run holds digest.lock; 0 sources run\n');
    process.exit(0);
  }
  const guard = setTimeout(() => { releaseLock(); process.exit(0); }, 5 * MIN);
  guard.unref();
  digest().then((d) => {
    if (print) process.stdout.write(summary(d) + '\n');
  }, (e) => {
    if (print) process.stdout.write(`opening-move digest: run failed: ${oneLine(e && e.message)}\n`);
  }).finally(() => {
    releaseLock();
    process.exit(0);
  });
}

module.exports = { REPAIRS, GUARD_LEGS, SOURCES, sweepFixture, parseCi, mergeCi, jobReds, scriptArgv, repairGate, noteText, digest, summary, P };
