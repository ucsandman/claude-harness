#!/usr/bin/env node
/**
 * tools/dashboard/tests/today-probe.cjs — Opening Move step 5: the dashboard Today tab's API.
 *
 *   node tools/dashboard/tests/today-probe.cjs          # the real server: every case must pass
 *   node tools/dashboard/tests/today-probe.cjs --stub   # the server over an empty stub home: every case must FAIL (L1)
 *
 * The probe starts tools/dashboard/dashboard.cjs on 7890 + a random offset (retried when the port
 * is taken), with HOME and USERPROFILE pointed at a temp home it seeds, so no real state is read
 * or written; it never opens a browser and kills the server in finally. In --stub mode the server
 * runs over a second, empty home while every assertion still reads the seeded one, so a case that
 * passes there proves nothing. The refresh route spawns a no-op job, never the real digest.
 * Cases: (a) GET numbers, (b) a POST without the session header is 403 and with it mutes an item
 * for 7 d, (c) kind demote/restore, (d) verifyGate enforce reaches config.json and
 * turn-close-probe still passes, (e) bad settings are 400, (f) the brief honours the mute and the
 * toggle, (g) dashboard-url.txt, (h) a foreign Origin is 403, (i) refresh behind digest.lock,
 * (j) a guard-class red cannot be muted, (k) Object.prototype names are 400 and never break GET,
 * (l) a non-loopback Host (DNS rebinding) is 403 on every GET, (m) a truncated mutes.json or
 * config.json is 409 and never overwritten.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const STUB = process.argv.includes('--stub');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER = path.join(ROOT, 'tools', 'dashboard', 'dashboard.cjs');
const HOOK = path.join(ROOT, 'engine', 'hooks', 'opening-move.cjs');
const TURN_CLOSE_PROBE = path.join(ROOT, 'engine', 'hooks', 'tests', 'turn-close-probe.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'today-probe-'));
const HOME = path.join(TMP, 'home'); // seeded; every assertion reads it
const STUB_HOME = path.join(TMP, 'stub-home'); // empty; the server's home under --stub
const SERVER_HOME = STUB ? STUB_HOME : HOME;
const STATE = path.join(HOME, '.claude', 'state', 'opening-move');
const URL_FILE = path.join(HOME, '.claude', 'state', 'dashboard-url.txt');
const NOOP_JOB = path.join(TMP, 'digest-noop.cjs');
for (const d of [STATE, STUB_HOME]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(NOOP_JOB, "'use strict';\n");

const H = 3600e3;
const DAY = 24 * H;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const sf = (name) => path.join(STATE, name);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const writeRows = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the seeded home: a digest with 2 reds, a ledger of 6 rows over 2 kinds, 4 finals (3 with Next) ---
const CRON = { kind: 'job-stale', text: 'CronwatchDaily: last result 1 (board lists failed tasks).', hash: 'cccccccccccc', ageMs: 0, guardClass: false, source: 'jobs' };
const NIGHT = { kind: 'job-stale', text: 'NightlyMeditation: latest-line.txt 51 d old (limit 26 h), last result 1.', hash: 'aaaaaaaaaaaa', ageMs: 51 * DAY, guardClass: false, source: 'jobs' };
const SRC8 = ['doctor', 'canary', 'jobs', 'ci', 'repos', 'hookErrors', 'learning', 'fixture'];
fs.writeFileSync(sf('digest.json'), JSON.stringify({ ts: iso(-5 * 60e3), from: 'schedule', ms: 1, sources: Object.fromEntries(SRC8.map((n) => [n, { ok: true, count: 3, ms: 1 }])), red: [CRON, NIGHT], fixed: [], ci: [], repos: [], fixture: { found: 5, of: 5, missed: [] } }));
writeRows(sf('ledger.jsonl'), [
  { ts: iso(-1 * DAY), repo: 'r', kind: 'resume', hash: 'h1', outcome: 'shown' },
  { ts: iso(-1 * DAY + 60e3), repo: 'r', kind: 'resume', hash: 'h1', outcome: 'taken' },
  { ts: iso(-10 * DAY), repo: 'r', kind: 'resume', hash: 'h0', outcome: 'shown' },
  { ts: iso(-2 * DAY), repo: 'r', kind: 'commit-scoped', hash: 'h2', outcome: 'shown' },
  { ts: iso(-2 * DAY + 60e3), repo: 'r', kind: 'commit-scoped', hash: 'h2', outcome: 'still-open' },
  { ts: iso(-3 * DAY), repo: 'r', kind: 'commit-scoped', hash: 'h3', outcome: 'ignored' },
]);
writeRows(sf('finals.jsonl'), [
  { ts: iso(-1 * H), session: 's1', repo: 'r', hasNext: true, owner: 'me' },
  { ts: iso(-2 * H), session: 's1', repo: 'r', hasNext: true, owner: 'you' },
  { ts: iso(-1 * DAY), session: 's2', repo: 'r', hasNext: false, owner: null },
  { ts: iso(-2 * DAY), session: 's3', repo: null, hasNext: true, owner: 'none' },
]);
// 3 would-blocks in 7 d (one nudged by a "did you test" prompt, one blocked by enforce), 1 older, 1 judged row
writeRows(sf('turn-close.jsonl'), [
  { ts: iso(-9 * DAY), session: 'w0', wouldBlock: true, mode: 'shadow' },
  { ts: iso(-3 * DAY), session: 'w3', wouldBlock: true, mode: 'shadow' },
  { ts: iso(-2 * DAY), session: 'w2', wouldBlock: true, blocked: true, mode: 'enforce' },
  { ts: iso(-1 * DAY), session: 'w1', wouldBlock: true, mode: 'shadow' },
  { ts: iso(-1 * DAY + 60e3), session: 'w1', nudged: true },
  { ts: iso(-1 * DAY + 90e3), session: 'w2', judged: true, blockTs: 'x', refused: false },
]);
fs.mkdirSync(sf('repos'), { recursive: true });
fs.writeFileSync(path.join(sf('repos'), 'c-probe-repo.json'), JSON.stringify({ repo: 'C:/probe/repo', lastBrief: { ts: iso(-H), kind: 'resume', hash: 'h1', owner: 'me', head: 'abc1234', text: 'run the probe suite', reds: 2 } }));

// --- the server ---
let child = null;
let PORT = 0;
let HDR = ''; // the per-process session header value the served page carries
let requests = 0;
let hookRuns = 0;
const serverEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(OPENING_MOVE|TURN_CLOSE_MODE|PORT$)/i.test(k)) delete env[k];
  return { ...env, USERPROFILE: SERVER_HOME, HOME: SERVER_HOME, OPENING_MOVE_DIGEST_JOB: NOOP_JOB };
};
/** Start on 7890 + a random offset; a port held by another app or another dashboard is retried. */
async function startServer() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const want = 7890 + Math.floor(Math.random() * 100);
    const c = spawn(process.execPath, [SERVER, '--port', String(want)], { env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    const end = Date.now() + 20000;
    let port = 0;
    while (Date.now() < end && c.exitCode === null) {
      const m = /Command Center live at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { port = Number(m[1]); break; }
      if (/already running|all taken/.test(out)) break;
      await sleep(100);
    }
    if (port) { child = c; PORT = port; return `port ${port} (asked ${want}, attempt ${attempt + 1})`; }
    try { c.kill(); } catch (_) {}
  }
  throw new Error('the dashboard did not start on any of 6 ports');
}
function request(method, route, { body, headers = {} } = {}) {
  requests++;
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route, timeout: 15000, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), json: null }));
    if (data) req.write(data);
    req.end();
  });
}
const AUTH = 'x-dashboard-token';
const post = (route, body, headers = { [AUTH]: HDR }) => request('POST', route, { body, headers });
const getState = async () => (await request('GET', '/api/opening-move')).json || {};

// --- the brief, run as a hook against the seeded home ---
function briefEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OPENING_MOVE|POST_EDIT_DIAG_LOG|GIT_DIR|GIT_WORK_TREE|CLAUDE_CODE_ENTRYPOINT)$/i.test(k)) env[k] = v;
  return { ...env, USERPROFILE: HOME, HOME, CLAUDE_CODE_ENTRYPOINT: 'cli', OPENING_MOVE_DIGEST_JOB: NOOP_JOB, GIT_CONFIG_NOSYSTEM: '1' };
}
function brief(cwd, sid) {
  hookRuns++;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: sid, cwd }), env: briefEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (_) {}
  return { ctx: json && json.hookSpecificOutput ? String(json.hookSpecificOutput.additionalContext || '') : '', sys: json ? json.systemMessage : undefined };
}
/** A harness-named repo (so digest reds are its NEXT candidates) with one commit and no remote. */
function harnessRepo() {
  const dir = path.join(TMP, 'f', 'agnostic-ai');
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync('git', ['-c', 'user.email=probe@probe.local', '-c', 'user.name=Probe', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: briefEnv(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'initial']);
  return dir;
}

const results = [];
async function kase(id, label, fn) {
  try {
    const detail = await fn();
    results.push([id, true]);
    console.log(`  PASS (${id}) ${label}${detail ? ` [${detail}]` : ''}`);
  } catch (e) {
    results.push([id, false]);
    console.log(`  FAIL (${id}) ${label}\n         ${String(e.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);
  }
}

(async () => {
  console.log(`today probe${STUB ? ' --stub (the server reads an empty home; every case must fail)' : ''}: server ${SERVER}`);
  try {
    const started = await startServer();
    const page = await request('GET', '/');
    const at = page.text.indexOf('const DASHBOARD_TOKEN');
    const hm = at < 0 ? null : /[0-9a-f]{48}/.exec(page.text.slice(at, at + 90));
    HDR = hm ? hm[0] : '';
    console.log(`  server up: ${started}, pid ${child.pid}; page ${page.text.length} bytes, session header ${HDR ? 'found' : 'MISSING'}; Today tab button ${/data-tab="today"/.test(page.text) ? 'present' : 'MISSING'}`);

    await kase('a', 'GET /api/opening-move over 2 reds, 6 ledger rows in 2 kinds, 4 finals (3 with Next) and 5 would-block rows: stats, verify, nextCoverage, settings and briefs come back exact', async () => {
      const s = await getState();
      assert.ok(s.digest && Array.isArray(s.digest.red), 'no digest: ' + JSON.stringify(s).slice(0, 200));
      assert.deepStrictEqual(s.digest.red.map((x) => x.hash), [CRON.hash, NIGHT.hash]);
      assert.deepStrictEqual(s.stats, [
        { kind: 'resume', shown7: 1, taken7: 1, ignored7: 0, open7: 0, shown14: 2, taken14: 1, rate14: 0.5, state: 'active' },
        { kind: 'commit-scoped', shown7: 1, taken7: 0, ignored7: 1, open7: 1, shown14: 1, taken14: 0, rate14: 0, state: 'active' },
      ]);
      assert.deepStrictEqual(s.verify, { wouldBlock7: 3, nudged7: 2, precision7: 2 / 3, mode: 'shadow' });
      assert.deepStrictEqual(s.nextCoverage, { finals: 4, withNext: 3 });
      assert.deepStrictEqual(s.settings, { enabled: true, repair: true, verifyGate: 'shadow' });
      const b = s.briefs['c-probe-repo'] || {};
      assert.deepStrictEqual([b.text, b.kind, b.reds, Number.isFinite(Date.parse(b.ts))], ['run the probe suite', 'resume', 2, true], 'briefs: ' + JSON.stringify(s.briefs));
      return `2 reds, 2 kinds from 6 ledger rows, nudged ${s.verify.nudged7} of ${s.verify.wouldBlock7} would-blocks, Next on ${s.nextCoverage.withNext} of ${s.nextCoverage.finals} finals`;
    });

    await kase('b', 'POST mute without the session header is 403 and mutes.json is untouched; with it the POST is 200 and the item carries an until 7 d out', async () => {
      const before = readText(sf('mutes.json'));
      const bare = await post('/api/opening-move/mute', { scope: 'item', key: CRON.hash, days: 7 }, {});
      const after403 = readText(sf('mutes.json'));
      const ok = await post('/api/opening-move/mute', { scope: 'item', key: CRON.hash, days: 7 });
      const until = Date.parse(((readJson(sf('mutes.json')) || {}).items || {})[CRON.hash]);
      assert.strictEqual(bare.status, 403, 'no header: ' + bare.status);
      assert.strictEqual(after403, before, 'a refused POST changed mutes.json');
      assert.strictEqual(ok.status, 200, 'with the header: ' + ok.status + ' ' + ok.text);
      assert.ok(Math.abs(until - (Date.now() + 7 * DAY)) < 2 * 60e3, `until ${until ? new Date(until).toISOString() : 'absent'} is not about 7 d out`);
      return `403 then 200; until ${Math.round((until - Date.now()) / H)} h out`;
    });

    await kase('c', 'POST mute scope kind: restore false demotes (GET state demoted), restore true restores (state active)', async () => {
      const d = await post('/api/opening-move/mute', { scope: 'kind', key: 'resume', restore: false });
      const k1 = ((readJson(sf('mutes.json')) || {}).kinds || {}).resume;
      const s1 = ((await getState()).stats || []).find((x) => x.kind === 'resume') || {};
      const r = await post('/api/opening-move/mute', { scope: 'kind', key: 'resume', restore: true });
      const k2 = ((readJson(sf('mutes.json')) || {}).kinds || {}).resume;
      const s2 = ((await getState()).stats || []).find((x) => x.kind === 'resume') || {};
      assert.deepStrictEqual([d.status, k1, s1.state, r.status, k2, s2.state], [200, 'demoted', 'demoted', 200, 'restored', 'active']);
      return '2 POSTs: demoted, then restored';
    });

    await kase('d', 'POST settings verifyGate enforce writes config.json; turn-close-probe still passes (its auto-quiet case flips its own temp home back to shadow); shadow restores', async () => {
      const e = await post('/api/opening-move/settings', { verifyGate: 'enforce' });
      const cfg = readJson(sf('config.json')) || {};
      assert.strictEqual(e.status, 200, e.text);
      assert.strictEqual(cfg.verifyGate, 'enforce', 'config.json: ' + JSON.stringify(cfg));
      const tc = spawnSync(process.execPath, [TURN_CLOSE_PROBE], { encoding: 'utf8', timeout: 300000, windowsHide: true });
      const last = String(tc.stdout || '').trim().split('\n').filter((l) => /cases ran/.test(l)).pop() || `no summary (exit ${tc.status})`;
      const s = await post('/api/opening-move/settings', { verifyGate: 'shadow' });
      const cfg2 = readJson(sf('config.json')) || {};
      assert.strictEqual(tc.status, 0, 'turn-close-probe: ' + last);
      assert.ok(/PASS \(m\) auto-quiet/.test(tc.stdout), 'the auto-quiet case did not pass');
      assert.deepStrictEqual([s.status, cfg2.verifyGate], [200, 'shadow']);
      return `enforce, then shadow; turn-close-probe: ${last}`;
    });

    await kase('e', 'POST settings: repair false is saved; verifyGate "yes", enabled "yes", an unknown key and an empty body are 400 and leave config.json as it was', async () => {
      const good = await post('/api/opening-move/settings', { repair: false });
      const saved = readText(sf('config.json'));
      assert.deepStrictEqual([good.status, (readJson(sf('config.json')) || {}).repair], [200, false], 'repair false was not saved');
      const bad = [];
      for (const body of [{ verifyGate: 'yes' }, { enabled: 'yes' }, { mode: 'enforce' }, {}]) bad.push((await post('/api/opening-move/settings', body)).status);
      const unchanged = readText(sf('config.json')) === saved;
      await post('/api/opening-move/settings', { repair: true });
      assert.deepStrictEqual(bad, [400, 400, 400, 400]);
      assert.ok(unchanged, 'a 400 changed config.json');
      return `1 saved, ${bad.filter((x) => x === 400).length} of 4 refused with 400`;
    });

    await kase('f', 'the brief against the seeded home: after a mute it prints "1 muted" and omits the muted red; with enabled false it prints the OFF answer', async () => {
      const dir = harnessRepo();
      await post('/api/opening-move/mute', { scope: 'item', key: CRON.hash, days: 7 });
      const m = brief(dir, 'tf1');
      const off0 = await post('/api/opening-move/settings', { enabled: false });
      const off = brief(dir, 'tf2');
      await post('/api/opening-move/settings', { enabled: true });
      assert.ok(/; 1 muted\.$/m.test(m.ctx), 'no "1 muted": ' + m.ctx);
      assert.ok(!/CronwatchDaily/.test(m.ctx + (m.sys || '')) && /NightlyMeditation/.test(m.ctx), 'the muted red must go, the other stay: ' + m.ctx);
      assert.strictEqual(off0.status, 200);
      assert.strictEqual(off.ctx, '[opening-move] off (dashboard toggle)');
      return '2 hook runs: 1 muted of 2 reds, then off';
    });

    await kase('g', 'dashboard-url.txt holds the server url, pid and start time while it runs', async () => {
      const u = readJson(URL_FILE) || {};
      const { ts, ...rest } = u;
      assert.deepStrictEqual(rest, { url: `http://127.0.0.1:${PORT}`, pid: child.pid }, 'dashboard-url.txt: ' + JSON.stringify(u));
      assert.ok(Number.isFinite(Date.parse(ts)) && Date.now() - Date.parse(ts) < 10 * 60e3, 'dashboard-url.txt ts: ' + ts);
      return `port ${PORT}, pid ${u.pid}`;
    });

    await kase('h', 'a POST with the right session header but a foreign Origin is 403 and writes nothing; a loopback Origin is 200 and writes', async () => {
      const before = readText(sf('mutes.json'));
      const evil = await post('/api/opening-move/mute', { scope: 'repo', key: 'probe-repo-h' }, { [AUTH]: HDR, origin: 'http://evil.example' });
      const unchanged = readText(sf('mutes.json')) === before;
      const local = await post('/api/opening-move/mute', { scope: 'repo', key: 'probe-repo-h' }, { [AUTH]: HDR, origin: `http://127.0.0.1:${PORT}` });
      const set = ((readJson(sf('mutes.json')) || {}).repos || {})['probe-repo-h'];
      await post('/api/opening-move/mute', { scope: 'repo', key: 'probe-repo-h', restore: true });
      assert.deepStrictEqual([evil.status, unchanged, local.status, set], [403, true, 200, true]);
      return '403 foreign, 200 loopback';
    });

    await kase('i', 'POST refresh: a live digest.lock gives {started:false, reason:"refresh running"}; a stale one is taken over, one job spawns and the lock names its pid', async () => {
      fs.writeFileSync(sf('digest.lock'), JSON.stringify({ pid: process.pid, ts: iso(-60e3) }));
      const held = await post('/api/opening-move/refresh', {});
      fs.writeFileSync(sf('digest.lock'), JSON.stringify({ pid: 1, ts: iso(-2 * H) })); // a dead holder: stale
      const go = await post('/api/opening-move/refresh', {});
      const lock = readJson(sf('digest.lock')) || {};
      assert.deepStrictEqual(held.json, { started: false, reason: 'refresh running' });
      assert.ok(go.json && go.json.started === true && Number.isInteger(go.json.pid), 'refresh: ' + go.text);
      assert.strictEqual(lock.pid, go.json.pid, 'digest.lock must name the spawned job: ' + JSON.stringify(lock));
      return `1 refused, 1 started (pid ${go.json.pid})`;
    });

    await kase('j', 'a guard-class red (a security leg false) cannot be muted: POST mute on its hash is 400 and mutes.json is untouched; an ordinary red still mutes (200)', async () => {
      const GUARD = { kind: 'guard-leg', text: 'GUARD secret-guard-denies-canary is not denying: do not trust guarded operations.', hash: 'bbbbbbbbbbbb', ageMs: 0, guardClass: true, source: 'canary' };
      const dg = readText(sf('digest.json'));
      const d = JSON.parse(dg);
      fs.writeFileSync(sf('digest.json'), JSON.stringify({ ...d, red: [GUARD, ...d.red] }));
      const before = readText(sf('mutes.json'));
      const g = await post('/api/opening-move/mute', { scope: 'item', key: GUARD.hash, days: 7 });
      const unchanged = readText(sf('mutes.json')) === before;
      const plain = await post('/api/opening-move/mute', { scope: 'item', key: NIGHT.hash, days: 7 });
      await post('/api/opening-move/mute', { scope: 'item', key: NIGHT.hash, restore: true });
      fs.writeFileSync(sf('digest.json'), dg);
      assert.deepStrictEqual([g.status, unchanged, plain.status], [400, true, 200], 'guard mute: ' + g.status + ' ' + g.text);
      assert.ok(/guard-class/.test(g.text), g.text);
      return '1 guard red refused with 400, 1 ordinary red muted with 200';
    });

    await kase('k', 'a key named after an Object.prototype member (constructor, toString, __proto__, prototype) is 400 on the kind, item and repo scopes; a hand-edited kinds.constructor in mutes.json leaves GET 200 with the 2 real kinds', async () => {
      const before = readText(sf('mutes.json'));
      const codes = [];
      for (const key of ['constructor', 'toString', '__proto__', 'prototype']) for (const scope of ['kind', 'item', 'repo']) codes.push((await post('/api/opening-move/mute', { scope, key })).status);
      const unchanged = readText(sf('mutes.json')) === before;
      fs.writeFileSync(sf('mutes.json'), JSON.stringify({ ...(readJson(sf('mutes.json')) || {}), kinds: { constructor: 'demoted', toString: 'demoted' } }));
      const g = await request('GET', '/api/opening-move');
      if (before === null) fs.unlinkSync(sf('mutes.json')); else fs.writeFileSync(sf('mutes.json'), before);
      assert.deepStrictEqual(codes, Array(12).fill(400), 'statuses: ' + codes.join(','));
      assert.ok(unchanged, 'a refused POST changed mutes.json');
      assert.strictEqual(g.status, 200, 'GET with a hand-edited kinds.constructor: ' + g.text.slice(0, 200));
      // case f's brief runs add their own ledger rows, so the seeded kinds are checked, not the whole list
      const kinds = (g.json.stats || []).map((s) => s.kind);
      assert.ok(kinds.includes('resume') && kinds.includes('commit-scoped') && !kinds.includes('constructor') && !kinds.includes('toString'), 'stats kinds: ' + JSON.stringify(kinds));
      return `${codes.filter((c) => c === 400).length} of 12 refused with 400; GET 200 with ${kinds.length} kinds, 0 named after Object.prototype`;
    });

    await kase('l', 'DNS rebinding: a non-loopback Host header is 403 on GET /api/opening-move and on GET / (no state, no session header); Host 127.0.0.1, localhost and [::1] are served', async () => {
      const evilState = await request('GET', '/api/opening-move', { headers: { host: `evil.example:${PORT}` } });
      const evilPage = await request('GET', '/', { headers: { host: `evil.example:${PORT}` } });
      const userinfo = await request('GET', '/api/opening-move', { headers: { host: `evil.example@127.0.0.1:${PORT}` } });
      const served = [];
      for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
        const r = await request('GET', '/api/opening-move', { headers: { host } });
        served.push(r.status === 200 && !!(r.json && r.json.digest && Array.isArray(r.json.digest.red) && r.json.digest.red.length === 2));
      }
      assert.deepStrictEqual([evilState.status, evilPage.status, userinfo.status], [403, 403, 403], 'foreign Hosts');
      assert.ok(!evilState.text.includes('CronwatchDaily') && !(HDR && evilPage.text.includes(HDR)), 'a refused GET leaked state or the session header');
      assert.deepStrictEqual(served, [true, true, true], 'loopback Hosts must be served the seeded digest');
      return '3 foreign Hosts refused with 403, 3 loopback Hosts served';
    });

    await kase('m', 'a truncated mutes.json or config.json is never overwritten: POST mute and POST settings are 409 and leave the bytes as they were; with the files restored both POSTs are 200 again', async () => {
      const okM = readText(sf('mutes.json'));
      const okC = readText(sf('config.json'));
      const brokenM = '{"items":{"cccccccccccc":"2099-01-01T00:00:00.000Z"';
      const brokenC = '{"verifyGate":"sha';
      fs.writeFileSync(sf('mutes.json'), brokenM);
      fs.writeFileSync(sf('config.json'), brokenC);
      const mute = await post('/api/opening-move/mute', { scope: 'repo', key: 'probe-repo-m' });
      const set = await post('/api/opening-move/settings', { repair: false });
      const kept = [readText(sf('mutes.json')) === brokenM, readText(sf('config.json')) === brokenC];
      if (okM == null) fs.unlinkSync(sf('mutes.json')); else fs.writeFileSync(sf('mutes.json'), okM);
      if (okC == null) fs.unlinkSync(sf('config.json')); else fs.writeFileSync(sf('config.json'), okC);
      const again = [(await post('/api/opening-move/mute', { scope: 'repo', key: 'probe-repo-m', restore: true })).status, (await post('/api/opening-move/settings', { repair: true })).status];
      assert.deepStrictEqual([mute.status, set.status, kept, again], [409, 409, [true, true], [200, 200]], JSON.stringify({ mute: mute.json, set: set.json, kept, again }));
      return '2 refused with 409, 0 bytes changed, 2 restored POSTs 200';
    });
  } catch (e) {
    console.log(`  ABORT ${String(e.message).slice(0, 300)}`);
  } finally {
    if (child) { try { child.kill(); } catch (_) {} }
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  const CASES = 13;
  const passed = results.filter(([, ok]) => ok).length;
  const failed = results.length - passed;
  console.log(`\n${results.length} of ${CASES} cases ran: ${passed} passed, ${failed} failed (${requests} HTTP requests, ${hookRuns} hook runs)`);
  if (STUB) {
    const bites = results.length === CASES && failed === CASES;
    console.log(bites ? `stub: ${failed} of ${CASES} cases failed as expected, the probe bites` : `stub: only ${failed} of ${results.length} cases failed; a case that passes against the stub proves nothing`);
    process.exit(bites ? 0 : 1);
  }
  process.exit(results.length === CASES && !failed ? 0 : 1);
})();
