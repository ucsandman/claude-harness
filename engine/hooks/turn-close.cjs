#!/usr/bin/env node
/**
 * engine/hooks/turn-close.cjs — the Opening Move Stop hook, build step 2 of
 * .agents/memory/2026-11-08-proactive-harness-tournament.md (section 2.4). It replaces
 * forced-verify-stop-gate.cjs, which read a field the Stop payload never carries.
 *
 * On every Stop (cli entrypoint only), at zero model tokens unless enforce blocks:
 *   next      the last `Next (me|you|none|wait YYYY-MM-DD): ...` line of
 *             payload.last_assistant_message (a 256 KB transcript tail when that field
 *             is absent), parsed and neutralised by opening-move.parseNext (160 chars,
 *             quotes and control characters made safe), written as `next` to the repo
 *             with the most FileModified paths this turn (the cwd repo on a tie).
 *   ring      every touched repo, and the cwd repo, gets this session's ring row updated with
 *             {source:'stop', touched, tainted, stopTs}; the row's prompt `ts` is kept.
 *   evidence  from the Mods bus ~/.claude/mods/state/events/<session_id>.jsonl (512 KB
 *             tail; the whole file up to 8 MB when the tail holds no human prompt): code edits,
 *             check commands and their results, outside-content reads (taint), lastTest.
 *   verify    a code edit with no passing check after it. A check run in the background, or
 *             masked after it by a pipe, ';', '||' or '&' (no pipefail), never passes. Mode: TURN_CLOSE_MODE env, then
 *             ~/.claude/state/opening-move/config.json {verifyGate}, default shadow.
 *             off: nothing. shadow: one row in turn-close.jsonl. enforce: a Stop block,
 *             at most once per human prompt (prompt_id when the bus has none), never
 *             while stop_hook_active.
 * Stdout is empty except for the enforce block; exit is always 0. The only bus-derived
 * string that can reach stdout is the last edited file's basename inside that block.
 * Each run's counts ("bus: <n> events scanned ...") go to turn-close-last.json.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// A broken opening-move.cjs must not turn every Stop into a stack trace: the CLI exits silent without it.
let om = null;
try { om = require('./opening-move.cjs'); } catch (_) {}

const HOME = process.env.USERPROFILE || os.homedir(); // the same derivation as opening-move.cjs, so both read one state dir
const STATE_DIR = path.join(HOME, '.claude', 'state', 'opening-move');
const P = {
  repos: path.join(STATE_DIR, 'repos'),
  sessions: path.join(STATE_DIR, 'sessions'),
  ledger: path.join(STATE_DIR, 'ledger.jsonl'),
  mutes: path.join(STATE_DIR, 'mutes.json'),
  config: path.join(STATE_DIR, 'config.json'),
  turnClose: path.join(STATE_DIR, 'turn-close.jsonl'),
  last: path.join(STATE_DIR, 'turn-close-last.json'),
};
const BUS_DIR = path.join(HOME, '.claude', 'mods', 'state', 'events');

const KB = 1024;
const BUS_TAIL = 512 * KB;
const BUS_MAX = 8 * KB * KB;
const TRANSCRIPT_TAIL = 256 * KB;
const RING_MAX = 5;
const TOUCHED_MAX = 200;
const REFUSE_MS = 120e3;
const MODES = new Set(['off', 'shadow', 'enforce']);
const CODE_RE = /\.(cjs|js|mjs|ts|tsx|py|ps1|sh|go|rs)$/i;
const VERIFY_RE = /\b(npm (run )?(test|lint|build|typecheck|doctor)|node --test|node \S*(probe|test|reg-)\S*|pytest|vitest|jest|cargo test|go test|tsc|eslint)\b/;
const TAINT_TOOL_RE = /^(WebFetch|WebSearch|mcp__)/;
const TAINT_CMD_RE = /declick (web|run)|curl\s+https?:|\bmole\b/;
const REFUSE_RE = /^(stop|no|skip|don'?t|leave it)\b/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WANT = new Set(['PromptSubmitted', 'FileModified', 'ToolRequested', 'ToolCompleted', 'SubagentStarted', 'SubagentCompleted']);
const KIND_RE = /^\{"kind":"([A-Za-z]+)"/;
// After the check command: a pipe, ';', '||' or a lone '&' hides its exit code. '&&' keeps it, and so
// do the redirections 2>&1, >&2 and &>file.
const MASK_RE = /\|(?!\|)|;|\|\||(^|[^&>])&(?![&>])/;
const UNMASK_RE = /pipefail|PIPESTATUS|LASTEXITCODE/;
const BG_ARGS_RE = /"run_in_background"\s*:\s*true/;
const BG_DONE_RE = /^Command running in background/;

// --- wrapped fs helpers: a read returns a default, a write never throws ---

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function readJson(p, dflt) { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : dflt; } catch (_) { return dflt; } }
function writeJson(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v));
    try { fs.renameSync(tmp, p); } catch (_) { fs.writeFileSync(p, JSON.stringify(v)); try { fs.unlinkSync(tmp); } catch (_) {} }
  } catch (_) {}
}
function appendLine(p, row) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(row) + '\n'); } catch (_) {} }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (_) { return null; } }
/** The last `bytes` of a file, first partial line dropped; null when unreadable. */
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
  } catch (_) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}
function jsonl(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch (_) {} }
  return out;
}
const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const lowPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A file name for stdout: basename only, [A-Za-z0-9._-] only. */
const baseName = (p) => String(p).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'the file you edited';

// --- the final message ---

/** The newest assistant text in a transcript tail (fallback when the payload has no last_assistant_message). */
function transcriptText(tp) {
  if (!tp || !/\.jsonl$/i.test(String(tp))) return null;
  const text = tail(String(tp), TRANSCRIPT_TAIL);
  if (text == null) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const c = o.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n') : '';
    if (t.trim()) return t;
  }
  return null;
}

// --- the Mods bus ---

function parseBus(text) {
  const events = [];
  let scanned = 0;
  for (const l of String(text).split('\n')) {
    if (!l || l === '\r') continue;
    scanned++;
    const k = KIND_RE.exec(l);
    if (k && !WANT.has(k[1])) continue; // ModelStep, PermissionRequested, ... are counted, not parsed
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (o && typeof o === 'object' && WANT.has(o.kind) && o.data && typeof o.data === 'object') events.push(o);
  }
  return { events, scanned };
}
// Only a human prompt opens a turn. A task notification, an auto-continuation or a peer message is a
// machine wake-up inside the same turn: counting it would drop the edits made before it unchecked.
// Bus origins seen on 2026-11-09: composer, sdk, task-notification, auto-continuation, peer.
const HUMAN_ORIGINS = new Set(['composer', 'sdk']);
const isHumanPrompt = (e) => e.kind === 'PromptSubmitted' && !e.agentId && (e.data.origin == null || HUMAN_ORIGINS.has(String(e.data.origin)));

/** {status:'ok'|'missing'|'too large'|'unreadable', events, scanned, note}. */
function readBus(sid) {
  const file = path.join(BUS_DIR, safeId(sid) + '.jsonl');
  const size = sizeOf(file);
  if (size == null) return { status: 'missing', events: [], scanned: 0, note: 'bus: 0 events (mods layer down)' };
  const text = tail(file, BUS_TAIL);
  if (text == null) return { status: 'unreadable', events: [], scanned: 0, note: 'bus: 0 events (unreadable)' };
  let r = parseBus(text);
  let where = size > BUS_TAIL ? '512 KB tail' : 'whole file';
  if (size > BUS_TAIL && !r.events.some(isHumanPrompt)) {
    if (size > BUS_MAX) return { status: 'too large', events: [], scanned: r.scanned, note: `bus: too large (${(size / KB / KB).toFixed(1)} MB, no human prompt in the 512 KB tail)` };
    const whole = readText(file);
    if (whole == null) return { status: 'unreadable', events: [], scanned: 0, note: 'bus: 0 events (unreadable)' };
    r = parseBus(whole);
    where = 'whole file, no human prompt in the tail';
  }
  return { status: 'ok', events: r.events, scanned: r.scanned, note: `bus: ${r.scanned} events scanned (${where})` };
}

/** A Bash/PowerShell command from args that may be an object, a JSON string, or a JSON string cut at 600 chars. */
function commandOf(args) {
  if (args && typeof args === 'object') return String(args.command || '').slice(0, 4000);
  const s = String(args || '');
  try { const o = JSON.parse(s); if (o && typeof o === 'object') return String(o.command || '').slice(0, 4000); } catch (_) {}
  const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
  if (!m) return s.slice(0, 4000);
  try { return JSON.parse(`"${m[1].replace(/\\$/, '')}"`); } catch (_) { return m[1]; }
}

/** A fixed-vocabulary name for a check command (never the raw command text). */
function checkLabel(m) {
  const s = m[1];
  if (m[3]) return `npm run ${m[3]}`;
  if (s === 'node --test') return s;
  if (m[4]) return m[4] === 'reg-' ? 'a node reg- suite' : `a node ${m[4]} script`;
  return s; // pytest, vitest, jest, cargo test, go test, tsc, eslint: the alternatives are literal
}

/** Walk up from a file to the directory holding .git; cached per directory. */
function repoTop(file, cache) {
  let dir;
  try { dir = path.dirname(path.resolve(String(file))); } catch (_) { return null; }
  const seen = [];
  for (let i = 0; i < 64; i++) {
    if (cache.has(dir)) { const v = cache.get(dir); for (const s of seen) cache.set(s, v); return v; }
    seen.push(dir);
    let hit = false;
    try { fs.statSync(path.join(dir, '.git')); hit = true; } catch (_) {}
    if (hit) { for (const s of seen) cache.set(s, dir); return dir; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const s of seen) cache.set(s, null);
  return null;
}

/**
 * The turn's evidence from the bus events: the window is everything after the last
 * human prompt (task notifications stay inside it). Edits by a subagent still running are
 * not this turn's; a passing check by any thread counts.
 */
function evidence(events, cache) {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) if (isHumanPrompt(events[i])) { start = i; break; }
  const prompt = start >= 0 ? events[start] : null;
  const win = events.slice(start + 1);
  const doneAgents = new Set(win.filter((e) => e.kind === 'SubagentCompleted' && e.agentId).map((e) => String(e.agentId)));
  const completions = new Map();
  for (const e of events) if (e.kind === 'ToolCompleted' && e.data.tool_use_id) completions.set(String(e.data.tool_use_id), e);

  const touched = new Map(); // repo key -> {top, paths: Map(lowPath -> path)}
  const codeEdits = []; // {pos, path}
  win.forEach((e, i) => {
    if (e.kind !== 'FileModified' || typeof e.data.path !== 'string' || !e.data.path) return;
    const p = e.data.path;
    const top = repoTop(p, cache);
    if (!top) return; // scratchpad and temp files are not repo code
    const key = om.repoKey(top);
    const t = touched.get(key) || { top, paths: new Map() };
    if (!t.paths.has(lowPath(p))) t.paths.set(lowPath(p), p);
    touched.set(key, t);
    if (CODE_RE.test(p) && (!e.agentId || doneAgents.has(String(e.agentId)))) codeEdits.push({ pos: start + 1 + i, path: p });
  });

  const checks = []; // every check command in the loaded events, with its result
  let tainted = false;
  events.forEach((e, pos) => {
    if (e.kind !== 'ToolRequested') return;
    const tool = String(e.data.tool || '');
    const inWin = pos > start;
    if (inWin && TAINT_TOOL_RE.test(tool)) tainted = true;
    if (!SHELL_TOOLS.has(tool)) return;
    const cmd = commandOf(e.data.args);
    if (inWin && TAINT_CMD_RE.test(cmd)) tainted = true;
    const m = VERIFY_RE.exec(cmd);
    if (!m) return;
    const c0 = completions.get(String(e.data.tool_use_id || ''));
    // A background run completes at once with "Command running in background": no result yet, so not done.
    const a = e.data.args;
    const bg = (a && typeof a === 'object' ? a.run_in_background === true : BG_ARGS_RE.test(String(a || '')))
      || !!(c0 && BG_DONE_RE.test(String(c0.data.preview || '')));
    const c = bg ? null : c0;
    // A masked exit code is no result either: it is counted as run, never as passed, never as lastTest.
    const masked = MASK_RE.test(cmd.slice(m.index + m[0].length)) && !UNMASK_RE.test(cmd);
    checks.push({ pos, inWin, cmd: m[0].slice(0, 120), label: checkLabel(m), done: !!c, masked, bg, isError: c && !masked ? c.data.isError === true : null, pass: !!c && !masked && c.data.isError === false, t: Number(e.t) || null });
  });

  const lastEdit = codeEdits.length ? codeEdits[codeEdits.length - 1] : null;
  const passed = checks.filter((c) => c.pass);
  const lastPass = passed.length ? passed[passed.length - 1] : null;
  const after = new Set(codeEdits.filter((x) => !lastPass || x.pos > lastPass.pos).map((x) => lowPath(x.path)));
  const bgPending = win.filter((e) => e.kind === 'SubagentStarted' && e.data.background === true && !e.data.denied
    && !(e.data.childAgentId && doneAgents.has(String(e.data.childAgentId)))).length;
  return {
    prompt, windowSize: win.length, touched, tainted, bgPending,
    codeFiles: new Set(codeEdits.map((x) => lowPath(x.path))).size,
    lastEdit,
    checksInWin: checks.filter((c) => c.inWin),
    passAfterEdit: lastEdit ? passed.filter((c) => c.pos > lastEdit.pos).length : 0,
    lastPass,
    editedAfterPass: after.size,
  };
}

// --- mode, once-per-prompt, auto-quiet ---

function gateMode(env) {
  const e = String(env.TURN_CLOSE_MODE || '').trim().toLowerCase();
  if (MODES.has(e)) return { mode: e, from: 'env TURN_CLOSE_MODE' };
  const c = readJson(P.config, {});
  const g = String(c.verifyGate || '').toLowerCase();
  if (MODES.has(g)) return { mode: g, from: 'config.json' };
  return { mode: 'shadow', from: 'default' };
}

/**
 * 2 of the last 5 blocks followed within 120 s by a human prompt that starts with
 * stop/no/skip/don't/leave it: set verifyGate to shadow. Prompt times and text come
 * from the bus PromptSubmitted rows (origin composer), which carry both. Only blocks after
 * the newest demotion count, so re-enabling enforce is not undone by the blocks it judged.
 */
function autoQuiet(sid, events, nowIso, repo) {
  const rows = jsonl(tail(P.turnClose, 64 * KB));
  const judged = new Set(rows.filter((r) => r.judged).map((r) => `${r.session}|${r.blockTs}`));
  const human = events.filter((e) => isHumanPrompt(e) && e.data.origin === 'composer');
  for (const b of rows.filter((r) => r.blocked === true && r.session === sid && !judged.has(`${sid}|${r.ts}`))) {
    const bt = Date.parse(b.ts);
    const p = human.find((e) => Number(e.t) > bt);
    if (!p) continue;
    const row = { ts: nowIso, session: sid, judged: true, blockTs: b.ts, refused: Number(p.t) - bt <= REFUSE_MS && REFUSE_RE.test(String(p.data.preview || '').trim()) };
    appendLine(P.turnClose, row);
    rows.push(row);
  }
  const refused = new Set(rows.filter((r) => r.judged && r.refused).map((r) => `${r.session}|${r.blockTs}`));
  const since = Math.max(0, ...rows.filter((r) => r.autoDemoted).map((r) => Date.parse(r.ts) || 0));
  const last5 = rows.filter((r) => r.blocked === true && (Date.parse(r.ts) || 0) > since).slice(-5);
  const n = last5.filter((b) => refused.has(`${b.session}|${b.ts}`)).length;
  if (n < 2) return false;
  const cfg = readJson(P.config, {});
  cfg.verifyGate = 'shadow';
  writeJson(P.config, cfg);
  appendLine(P.ledger, { ts: nowIso, repo: repo || null, kind: 'verify-gate', hash: null, outcome: 'auto-demoted' });
  appendLine(P.turnClose, { ts: nowIso, session: sid, autoDemoted: true, refused: n, of: last5.length });
  return true;
}

function trimTurnClose() {
  try {
    if (fs.statSync(P.turnClose).size < 1024 * KB) return;
    const keep = String(readText(P.turnClose) || '').split('\n').filter(Boolean).slice(-2000);
    fs.writeFileSync(P.turnClose, keep.join('\n') + '\n');
  } catch (_) {}
}

// --- ledger writes ---

function updateRepo(key, top, sid, evt, nowIso, rowPatch, fields) {
  const file = path.join(P.repos, key + '.json');
  const rs = readJson(file, {});
  rs.repo = rs.repo || top;
  if (rowPatch) {
    const ring = (Array.isArray(rs.ring) ? rs.ring : []).filter((r) => r && typeof r === 'object' && r.session);
    const old = ring.find((r) => r.session === sid);
    const merged = new Map();
    for (const p of [...(old && Array.isArray(old.touched) ? old.touched : []), ...rowPatch.touched]) if (!merged.has(lowPath(p))) merged.set(lowPath(p), String(p));
    const row = {
      ...(old || { session: sid, transcript_path: String(evt.transcript_path || ''), cwd: String(evt.cwd || ''), ts: nowIso }),
      source: 'stop', stopTs: nowIso,
      touched: [...merged.values()].slice(-TOUCHED_MAX),
      tainted: (old && old.tainted === true) || rowPatch.tainted === true,
    };
    rs.ring = [row, ...ring.filter((r) => r.session !== sid)].sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0)).slice(0, RING_MAX);
  }
  Object.assign(rs, fields);
  writeJson(file, rs);
}

// --- the Stop hook ---

/** Returns {out, info}: out is the stdout text ('' or the enforce block JSON). Never throws on a bad source. */
function close(evt, opts = {}) {
  const env = opts.env || process.env;
  const t0 = process.hrtime.bigint();
  const info = { ts: new Date().toISOString(), gate: null };
  const done = (out) => { info.ms = Number((process.hrtime.bigint() - t0) / 1000n) / 1000; return { out, info }; };
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli') { info.gate = 'entrypoint not cli'; return done(''); }
  if (!evt || evt.hook_event_name !== 'Stop') { info.gate = 'not a Stop event'; return done(''); }
  const sid = String(evt.session_id || '').trim();
  if (!sid) { info.gate = 'no session_id'; return done(''); }
  if (String(env.OPENING_MOVE || '').toLowerCase() === 'off' || readJson(P.mutes, {}).all === true) { info.gate = 'opening move off'; return done(''); }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const promptId = safeId(evt.prompt_id);
  Object.assign(info, { session: sid, prompt_id: promptId || null });

  // 1. the Next line
  const fromPayload = typeof evt.last_assistant_message === 'string';
  const text = fromPayload ? evt.last_assistant_message : transcriptText(evt.transcript_path);
  const nx = text ? om.parseNext(text) : null;
  info.text = fromPayload ? 'payload' : text != null ? 'transcript tail' : 'none';

  // 2. bus evidence
  const { mode: mode0, from } = gateMode(env);
  let mode = mode0;
  const bus = readBus(sid);
  const cache = new Map();
  const ev = bus.status === 'ok' ? evidence(bus.events, cache) : null;
  info.bus = bus.note;
  info.scanned = bus.scanned;

  // 3. repos: the Next goes to the repo with the most touched paths, the cwd repo on a tie
  const cwdTop = evt.cwd ? repoTop(path.join(String(evt.cwd), '.turn-close'), cache) : null; // repoTop starts at the file's directory
  const cwdKey = cwdTop ? om.repoKey(cwdTop) : null;
  const touched = ev ? ev.touched : new Map();
  let primary = null;
  for (const [key, t] of touched) {
    const n = t.paths.size;
    if (!primary || n > primary.n || (n === primary.n && key === cwdKey)) primary = { key, top: t.top, n };
  }
  if (!primary && cwdTop) primary = { key: cwdKey, top: cwdTop, n: 0 };
  info.repo = primary ? primary.key : null;
  info.touchedRepos = touched.size;

  // 4. writes: next and lastTest to the primary repo, a ring row to every touched repo, the primary and
  // the cwd repo (whose row is the one the go binding reads `tainted` from, wherever the edits landed)
  const lastCheck = ev ? [...ev.checksInWin].reverse().find((c) => c.done && !c.masked) : null;
  if (primary) {
    const fields = {};
    if (nx) fields.next = { text: nx.text, owner: nx.owner, waitUntil: nx.waitUntil || null, ts: nowIso, session: sid, prompt_id: promptId || null, source: 'stop' };
    if (lastCheck) fields.lastTest = { cmd: lastCheck.cmd, isError: lastCheck.isError, ts: new Date(lastCheck.t || now).toISOString(), session: sid };
    const keys = new Set([...touched.keys(), primary.key, ...(cwdKey ? [cwdKey] : [])]);
    for (const key of keys) {
      const t = touched.get(key);
      const top = t ? t.top : key === primary.key ? primary.top : cwdTop;
      updateRepo(key, top, sid, evt, nowIso, ev ? { touched: t ? [...t.paths.values()] : [], tainted: ev.tainted } : null, key === primary.key ? fields : {});
    }
  }
  info.next = nx ? `${nx.owner}${primary ? '' : ' (not written: no repo)'}` : 'no Next line';
  info.lastTest = lastCheck ? (lastCheck.isError ? 'failed' : 'passed') : 'none this turn';

  // 5. verify check
  info.mode = `${mode} (${from})`;
  let verdict;
  if (ev) {
    Object.assign(info, { window: ev.windowSize, edits: ev.codeFiles, verifies: ev.checksInWin.length, passAfterEdit: ev.passAfterEdit, tainted: ev.tainted });
  }
  // auto-quiet tunes the config gate only; an env TURN_CLOSE_MODE=enforce is Wes's explicit pin
  if (mode === 'enforce' && ev && from !== 'env TURN_CLOSE_MODE' && autoQuiet(sid, bus.events, nowIso, primary && primary.key)) {
    mode = 'shadow';
    info.autoDemoted = true;
    info.mode = `${mode} (auto-demoted)`;
  }
  const bg = Array.isArray(evt.background_tasks) ? evt.background_tasks.filter((b) => b && b.status === 'running' && /workflow|agent/i.test(String(b.type || ''))).length : 0;
  // Once per human prompt: the bus prompt's seq when there is one, prompt_id only as the fallback. A
  // task-notification turn can carry an older prompt's prompt_id (2026-11-09: a Stop after a task
  // notification at 05:48 had the id of the 04:49 prompt, not of the 05:45 one).
  const promptKey = ev && ev.prompt && ev.prompt.seq != null ? `seq:${Number(ev.prompt.seq)}` : promptId ? `id:${promptId}` : null;
  const sfile = path.join(P.sessions, safeId(sid) + '.json');
  const ses = readJson(sfile, {});
  if (mode === 'off') verdict = 'off';
  else if (!ev) verdict = `skip: ${bus.note}`;
  else if (!ev.codeFiles) verdict = 'skip: no code edits';
  else if (evt.stop_hook_active === true) verdict = 'skip: stop_hook_active';
  else if (ev.bgPending || bg) verdict = `skip: background work running (${ev.bgPending + bg})`;
  else if (ev.passAfterEdit > 0) verdict = 'pass';
  else if (promptKey && ses.blockedForPromptId === promptKey) verdict = 'skip: once per prompt';
  else verdict = mode === 'enforce' ? 'block' : 'wouldBlock';
  info.verdict = verdict;

  let out = '';
  if (verdict === 'wouldBlock' || verdict === 'block') {
    appendLine(P.turnClose, { ts: nowIso, session: sid, prompt_id: promptId || null, repo: primary ? primary.key : null, edits: ev.codeFiles, verifies: ev.checksInWin.length, wouldBlock: true, ...(verdict === 'block' ? { blocked: true } : {}), mode });
    if (promptKey) { ses.blockedForPromptId = promptKey; writeJson(sfile, ses); }
    trimTurnClose();
    if (verdict === 'block') {
      const n = ev.editedAfterPass || ev.codeFiles;
      const reason = `[turn-close] You edited ${pl(n, 'code file')} after your last passing check (${ev.lastPass ? ev.lastPass.label : 'none'}). Run the narrowest test that exercises ${baseName(ev.lastEdit.path)}, read the output, then finish.`;
      out = JSON.stringify({ decision: 'block', reason });
    }
  }
  const r = done(out);
  info.line = `[turn-close] mode ${info.mode}: ${bus.note}${ev ? `, ${ev.windowSize} in this turn` : ''}; ${ev ? `${pl(ev.codeFiles, 'code file')} edited, ${pl(ev.checksInWin.length, 'check')} run (${ev.passAfterEdit} passing after the last edit)` : 'edits and checks: unknown'}; verdict ${verdict}; next ${info.next}${primary ? ` -> ${primary.key}` : ''}; ${pl(touched.size, 'repo')} touched; ${info.ms} ms`;
  return r;
}

if (require.main === module) {
  const guard = setTimeout(() => process.exit(0), 4500); // well under the 10 s hook timeout: exit silent, never hang
  guard.unref();
  let evt = {};
  try { evt = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) {}
  if (!om) process.exit(0); // opening-move.cjs failed to load: no parse, no ledger, no output
  let r = { out: '', info: null };
  try { r = close(evt); } catch (e) { r = { out: '', info: { ts: new Date().toISOString(), error: String(e && e.message).slice(0, 200) } }; }
  if (r.info && r.info.gate !== 'entrypoint not cli') writeJson(P.last, r.info);
  if (!r.out) process.exit(0);
  process.stdout.write(r.out, () => process.exit(0));
}

module.exports = { close, evidence, parseBus, readBus, commandOf, checkLabel, gateMode, VERIFY_RE, CODE_RE, STATE_DIR, BUS_DIR };
