#!/usr/bin/env node
/**
 * engine/hooks/opening-move.cjs — the Opening Move brief, build step 1 of
 * .agents/memory/2026-11-08-proactive-harness-tournament.md (sections 2.2 and 2.3).
 *
 * SessionStart (run as a file, matcher startup|clear|compact): one JSON answer on
 * stdout ({systemMessage?, hookSpecificOutput:{hookEventName:'SessionStart',
 * additionalContext}}) or nothing; always exit 0. It tells a new session what
 * changed in this repo since the last session here, what is half done, and ONE
 * NEXT with its owner, at zero model tokens. Every source prints the count it
 * processed and, on failure, why (rules L1/L2).
 *   gates    CLAUDE_CODE_ENTRYPOINT must be 'cli'; source 'resume' prints nothing;
 *            OPENING_MOVE=off or a mute prints only the off line.
 *   sources  three parallel git calls (execFile, windowsHide, 600 ms each); the repo
 *            ledger ~/.claude/state/opening-move/repos/<key>.json; the newest ring
 *            row's transcript tail (fallback for the Next line); markers D1-D4.
 *   ladder   rank(state) is pure: ten rungs, first `me` match wins; HARD_STOP_RE
 *            turns any NEXT that names a hard stop into "prepare <x>; <x> stays
 *            yours" with owner `you`, which is listed for Wes and never executed.
 * UserPromptSubmit (main(evt), inside prompt-dispatch.cjs): appends a ring row and
 * binds a whole-prompt "go" to the NEXT the brief showed (at most once per NEXT).
 *
 * The output carries only counts, short shas, ages, repo-controlled file and branch
 * names and the stored Next text (160 chars, control characters stripped, double
 * quotes and backticks turned into '): never a
 * commit subject, transcript prose or file contents.
 * Not built yet, each printed as such: turn-close.jsonl and the ledger fields
 * next/lastTest/touched (turn-close.cjs, step 2), digest.json and the fixture
 * (step 3), the dashboard Today tab (step 5).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { isMachineTurn } = require('./wakeup-guard.cjs');

const HOME = process.env.USERPROFILE || os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'state', 'opening-move');
const P = {
  repos: path.join(STATE_DIR, 'repos'),
  sessions: path.join(STATE_DIR, 'sessions'),
  ledger: path.join(STATE_DIR, 'ledger.jsonl'),
  seen: path.join(STATE_DIR, 'seen.json'),
  mutes: path.join(STATE_DIR, 'mutes.json'),
  turnClose: path.join(STATE_DIR, 'turn-close.jsonl'),
};
const CLAUDE_HOME = path.join(HOME, '.claude');
const HANDOFF_INDEX = path.join(HOME, '.context-handoff-bundles', 'index.json');
const DIAG_LOG = process.env.POST_EDIT_DIAG_LOG || path.join(CLAUDE_HOME, 'logs', 'post-edit-diagnostics.jsonl');
const INBOX = path.join(HOME, 'clawd', 'agent-comms', 'inbox');

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GIT_TIMEOUT_MS = 600;
const RING_MAX = 5;
const SIBLING_MS = 10 * MIN;
const CAP = 1400;
const COMPACT_CAP = 300;
const NEXT_MAX = 160;
const STAT_MAX = 300;

// Spec 2.2's list widened to inflected forms (deploying, deleted, posting) and the hard-stop
// commands it missed (push -f, reset --hard, clean -f, rm -r, audit fix). Over-matching only
// moves an item to LEFT FOR WES; under-matching lets "go" start it.
const HARD_STOP_RE = /\b(deploy\w*|publish\w*|releas\w*|migrat\w*|force[- ]?push\w*|push\b[^\n]*?\s(?:--force|-f\b|\+\w)|send\w*|post(?:s|ed|ing)?\b|e-?mail\w*|tweet\w*|dms?\b|outreach|invit\w*|delet\w*|drop\w*|rm\s+-|rmdir\b|remove-item\b|clean\s+-\w*f|reset\s+--hard|branch\s+-d\b|uninstall\w*|audit\s+fix|overwrit\w*|prod(?:uction)?\b|dns\b|billing\b|stripe\b|clerk\b|render\b|neon\b|auth\b)/i;
const GO_FIRST_RE = /^\s*(go|go ahead|continue|next|resume|do it|yes|ok|start|what'?s next\??|hi|hey|morning)\W*$/i;
const GO_LATER_RE = /^\s*(go|go ahead|continue|next|resume|do it|yes|ok|start|what'?s next\??)\W*$/i;
const NUDGE_RE = /\b(test|verify|did you (run|check)|run it|check it|prove)\b/i;
// The closing Next line (rule text, spec 2.8). Untagged means `you`; "Next (none)" needs no colon.
const NEXT_LINE_RE = /^[ \t>*_-]*Next[ \t]*(?:\((me|you|none|wait[ \t]+(\d{4}-\d{2}-\d{2}))\))?[*_]*[ \t]*(?::[*_]*[ \t]*(.*?)[ \t]*$|$)/gim;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;
const QUOTE_RE = /["`\u201c\u201d\u201e\u201f\u2033\uff02]/g;
const RED_KINDS = new Set(['ci-red', 'tests-red', 'harness-red']);
const USE_LINE = 'USE: Wes\'s prompt wins. "go", "continue", "next", "resume" or a greeting means start NEXT now. Otherwise do his task, and if NEXT is still open make it your closing Next line. Do not re-measure what this brief measured. A you-owned or hard-stop item is prepared (action, environment, side effects, rollback), never executed.';

// --- small wrapped helpers: every fs read returns a default instead of throwing ---

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function readJson(p, dflt) {
  try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : dflt; } catch (_) { return dflt; }
}
function writeJson(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v));
    try { fs.renameSync(tmp, p); } catch (_) { fs.writeFileSync(p, JSON.stringify(v)); try { fs.unlinkSync(tmp); } catch (_) {} }
  } catch (_) {}
}
function appendLine(p, row) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(row) + '\n'); } catch (_) {} }
function mtimeOf(p) { try { return fs.statSync(p).mtimeMs; } catch (_) { return null; } }
/** The last `bytes` of a file as text, first partial line dropped; null when unreadable. */
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
function firstLine(p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); const b = Buffer.alloc(512); const k = fs.readSync(fd, b, 0, 512, 0); return b.slice(0, k).toString('utf8').split(/\r?\n/)[0]; } catch (_) { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}
function jsonl(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch (_) {} }
  return out;
}

/** Strip control and bidi characters, collapse whitespace, cap the length. */
function clean(s, max = NEXT_MAX) { return String(s == null ? '' : s).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim(); }
/** Stored or transcript Next text: cleaned, at most 160 chars, double quotes and backticks made ' so it cannot close a quoted span. */
function nextText(s) { return clean(s, NEXT_MAX).replace(QUOTE_RE, "'"); }
/** A repo-controlled name (file, branch, slug): cleaned, no quotes or markup. */
function nameOnly(s, max = 80) { return clean(s, max).replace(/[`"<>]/g, ''); }
function sha12(...parts) { return crypto.createHash('sha1').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 12); }
function ago(ms) {
  ms = Math.max(0, ms || 0);
  if (ms < MIN) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}
const pad2 = (n) => String(n).padStart(2, '0');
function day(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function hhmm(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const isOff = (env) => String(env.OPENING_MOVE || '').toLowerCase() === 'off';
/** State key: the repo path lower-cased with every run of [^a-z0-9] replaced by '-'. */
function repoKey(top) { return String(top).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function sidFile(sid) { return path.join(P.sessions, String(sid).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function ringOf(rs) {
  return (Array.isArray(rs && rs.ring) ? rs.ring : [])
    .filter((r) => r && typeof r === 'object' && r.session && ISO_RE.test(String(r.ts)))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, RING_MAX);
}

// --- hard stops and owners ---

/** Any NEXT naming a hard stop becomes "prepare <x>; <x> stays yours", owner `you`. Idempotent. */
function hardStop(text, owner) {
  const t = clean(text, NEXT_MAX * 2 + 40).replace(QUOTE_RE, "'");
  const m = HARD_STOP_RE.exec(t);
  if (!m) return { text: t, owner, hardStop: null };
  if (/^prepare .+ stays yours$/i.test(t)) return { text: t, owner: 'you', hardStop: m[1].toLowerCase() };
  const x = clean(t, NEXT_MAX).replace(/[\s.;:!?]+$/, '');
  return { text: `prepare ${x}; ${x} stays yours`, owner: 'you', hardStop: m[1].toLowerCase() };
}

/** Effective owner of a stored Next: me | you | none | hidden (wait until a future or unparsable date). */
function ownerOf(nx, now) {
  const o = String((nx && nx.owner) || 'you').toLowerCase();
  if (o === 'me' || o === 'none') return o;
  if (o === 'wait') { const wu = Date.parse(nx.waitUntil); return wu <= now ? 'me' : 'hidden'; }
  return 'you';
}

/** The last Next line of a message: {text, owner, waitUntil} or null. */
function parseNext(text) {
  const re = new RegExp(NEXT_LINE_RE.source, 'gim');
  let m;
  let last = null;
  while ((m = re.exec(String(text || '')))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const tag = (m[1] || '').toLowerCase();
    const body = nextText(m[3] || '');
    if (!body && tag !== 'none') continue;
    last = { tag, wait: m[2] || null, body };
  }
  if (!last) return null;
  const owner = last.tag.startsWith('wait') ? 'wait' : (last.tag || 'you');
  return { text: last.body, owner, waitUntil: last.wait };
}

/** Fallback for the ledger `next`: the last Next line of the newest assistant text in a transcript tail. */
function transcriptNext(tp) {
  if (!tp || !/\.jsonl$/i.test(String(tp))) return undefined;
  const text = tail(tp, 256 * 1024);
  if (text == null) return undefined;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const c = o.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n') : '';
    if (!t.trim()) continue;
    const nx = parseNext(t);
    if (!nx) return null;
    const ts = Date.parse(o.timestamp) || mtimeOf(tp) || Date.now();
    return { ...nx, ts: new Date(ts).toISOString(), source: 'transcript' };
  }
  return null;
}

// --- repo and git ---

function findRepo(cwd) {
  let dir;
  try { dir = path.resolve(String(cwd || process.cwd())); } catch (_) { return null; }
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (_) {}
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) || '');
        if (!m) return null;
        gitDir = path.resolve(dir, m[1].trim());
      }
      return { top: dir, gitDir };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Branch and short HEAD sha from the git dir (fs only, so the three git calls stay three). */
function gitHead(gitDir) {
  const head = clean(readText(path.join(gitDir, 'HEAD')), 300);
  const cd = readText(path.join(gitDir, 'commondir'));
  const common = cd ? path.resolve(gitDir, cd.trim()) : gitDir;
  let branch = null;
  let sha = null;
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (m) {
    branch = m[1];
    sha = clean(readText(path.join(gitDir, 'refs', 'heads', branch)) || readText(path.join(common, 'refs', 'heads', branch)), 64);
    if (!/^[0-9a-f]{40}/.test(sha)) {
      const packed = readText(path.join(common, 'packed-refs')) || '';
      const line = packed.split('\n').find((l) => l.trim().endsWith(' refs/heads/' + branch));
      sha = line && /^[0-9a-f]{40}/.test(line) ? line.slice(0, 40) : null;
    }
  } else if (/^[0-9a-f]{40}/.test(head)) sha = head;
  return { branch: branch ? nameOnly(branch, 60) : (sha ? 'detached' : 'unknown'), head: sha ? sha.slice(0, 7) : null, common };
}

function configEmail(text) {
  let inUser = false;
  let email = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (sec) { inUser = sec[1].toLowerCase() === 'user' && !/"/.test(line); continue; }
    if (inUser) { const kv = /^email\s*=\s*(.*)$/i.exec(line); if (kv) email = kv[1].replace(/\s+[#;].*$/, '').replace(/^"|"$/g, '').trim(); }
  }
  return email;
}
/** This repo's user.email: local config, then the global ones. '' when unknown (then every commit counts as foreign). */
function userEmail(common) {
  const home = process.env.HOME || HOME;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  for (const p of [path.join(common, 'config'), path.join(home, '.gitconfig'), path.join(HOME, '.gitconfig'), path.join(xdg, 'git', 'config')]) {
    const e = configEmail(readText(p));
    if (e) return e.toLowerCase();
  }
  return '';
}

function git(args, cwd) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, out: String(stdout || ''), ms: Date.now() - t0 });
        let why = `exit ${err.code}`;
        if (err.code === 'ENOENT') why = 'git not found';
        else if (err.killed || err.signal) why = `timeout ${GIT_TIMEOUT_MS} ms`;
        else if (/no upstream|does not point to a branch|ambiguous argument '@\{u\}/i.test(String(stderr || ''))) why = 'no upstream';
        else if (/does not have any commits|bad default revision/i.test(String(stderr || ''))) why = 'no commits';
        resolve({ ok: false, why, ms: Date.now() - t0 });
      });
    } catch (_) { resolve({ ok: false, why: 'spawn failed', ms: Date.now() - t0 }); }
  });
}

function parseStatus(out) {
  const rows = [];
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0 && /^[RC]/.test(line)) p = p.slice(arrow + 4);
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1');
    rows.push({ path: p, code: line.slice(0, 2) });
  }
  return rows;
}

function deploysOnPush(top) {
  for (const f of ['vercel.json', '.vercel', 'render.yaml', 'netlify.toml', 'fly.toml']) { try { if (fs.existsSync(path.join(top, f))) return true; } catch (_) {} }
  try { return fs.readdirSync(path.join(top, '.github', 'workflows')).some((f) => /deploy/i.test(f)); } catch (_) { return false; }
}

// --- half-done markers D1-D4 (undefined = source absent, which skips the rung) ---

/** D1: the newest handoff bundle for this repo, created after the last session here and under 7 days old. */
function handoffMarker(top, afterMs, now) {
  const text = readText(HANDOFF_INDEX);
  if (text == null) return undefined;
  let arr;
  try { arr = JSON.parse(text); } catch (_) { return undefined; }
  if (!Array.isArray(arr)) arr = Array.isArray(arr && arr.bundles) ? arr.bundles : [];
  const want = normPath(top);
  let best = null;
  for (const e of arr) {
    if (!e || typeof e !== 'object' || normPath(e.repo_root || '') !== want) continue;
    const t = Date.parse(e.created_at);
    if (!(t > afterMs) || now - t > 7 * DAY) continue;
    if (!best || t > best.t) best = { t, slug: e.slug };
  }
  if (!best) return null;
  const slug = /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(String(best.slug || '')) ? String(best.slug) : null;
  return { slug, createdMs: best.t };
}

/** D2: unchecked "- [ ]" items in .agents/memory/{plans,tasks}/*.md modified in the last 14 days. */
function taskMarker(top, now) {
  const found = [];
  for (const sub of ['plans', 'tasks']) {
    const dir = path.join(top, '.agents', 'memory', sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names.filter((f) => f.endsWith('.md')).slice(0, 200)) {
      const fp = path.join(dir, n);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (!st.isFile() || now - st.mtimeMs > 14 * DAY || st.size > 512 * 1024) continue;
      let count = 0;
      let first = 0;
      (readText(fp) || '').split('\n').forEach((l, i) => { if (/^\s*[-*]\s+\[ \]\s+\S/.test(l)) { count++; if (!first) first = i + 1; } });
      if (count) found.push({ file: `.agents/memory/${sub}/${nameOnly(n, 80)}`, count, line: first, mtimeMs: st.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** D3: files in this repo whose last post-edit diagnostic failed and that were not touched since. */
function syntaxMarker(top) {
  const text = tail(DIAG_LOG, 256 * 1024);
  if (text == null) return undefined;
  const want = normPath(top) + '/';
  const last = new Map();
  for (const r of jsonl(text)) { if (r.file && normPath(r.file).startsWith(want)) last.set(normPath(r.file), r); }
  const out = [];
  for (const r of last.values()) {
    if (r.ok !== false) continue;
    const ts = Date.parse(r.ts);
    const m = mtimeOf(String(r.file));
    if (!ts || m == null || m > ts + 2000) continue;
    out.push({ file: nameOnly(path.relative(top, String(r.file)).replace(/\\/g, '/'), 120), tsMs: ts });
  }
  return out.sort((a, b) => b.tsMs - a.tsMs);
}

/** D4: files in ~/clawd/agent-comms/inbox whose name or first line names the repo (count only). */
function inboxMarker(name) {
  let ents;
  try { ents = fs.readdirSync(INBOX, { withFileTypes: true }); } catch (_) { return undefined; }
  const want = String(name).toLowerCase();
  let n = 0;
  let of = 0;
  for (const e of ents.slice(0, 100)) {
    if (!e.isFile()) continue;
    of++;
    if (e.name.toLowerCase().includes(want) || firstLine(path.join(INBOX, e.name)).toLowerCase().includes(want)) n++;
  }
  return { n, of };
}

// --- the NEXT ladder ---

function testName(cmd) {
  const m = /\b(npm (?:run )?[\w:-]+|node --test|node \S*(?:probe|test|reg-)\S*|pytest|vitest|jest|cargo test|go test|tsc|eslint)\b/.exec(String(cmd || ''));
  return m ? nameOnly(m[1], 60) : 'a test command';
}

/**
 * rank(state) -> { next, leftForWes, open, also, hidden, red, matched, checked, skipped, archived, kinds }.
 * Pure: reads only `state`. A source that is undefined skips its rung (listed in `skipped`).
 * state: { now, repo:{top,name,branch,head,isAgnostic,deploysOnPush}, git:{status:{ok,why,dirty:[{path,mtimeMs}]},
 *   ahead:{ok,why,n}}, ci?, digest?, lastTest?, next?, touched?, markers:{handoff?,syntax?,tasks}, demoted, staleTop }
 */
function rank(state) {
  const s = state || {};
  const now = s.now || Date.now();
  const repo = s.repo || {};
  const st = (s.git && s.git.status) || { ok: false, why: 'not run' };
  const ah = (s.git && s.git.ahead) || { ok: false, why: 'not run' };
  const dirty = st.ok && Array.isArray(st.dirty) ? st.dirty : [];
  const mk = s.markers || {};
  const res = { next: null, leftForWes: [], open: [], also: [], hidden: 0, red: [], matched: 0, checked: 0, skipped: [], archived: 0, kinds: {} };
  const items = [];
  const skip = (rung, kind, why) => res.skipped.push({ rung, kind, why });
  const add = (rung, kind, text, owner, est, evidence, ageMs, short) => items.push({ rung, kind, text, owner, est, hash: sha12(kind, evidence), ageMs, short });
  const branch = nameOnly(repo.branch || 'unknown', 60);

  // 1 ci-red
  if (!Array.isArray(s.ci)) skip(1, 'ci-red', 'digest: not built (step 3)');
  else {
    res.checked++;
    const row = s.ci.find((r) => r && r.branch === repo.branch && r.conclusion === 'failure');
    if (row) {
      const t = Date.parse(row.createdAt) || now;
      add(1, 'ci-red', `CI failed on ${branch} at ${nameOnly(row.headSha, 7)} (${nameOnly(row.workflow, 60)}, run ${Number(row.runId) || 0}, ${ago(now - t)} ago): read the failing log and fix it.`, 'me', '10 min', `${row.headSha}|${row.runId}`, now - t, `CI red on ${branch}`);
    }
  }
  // 2 tests-red
  if (!s.lastTest || typeof s.lastTest !== 'object') skip(2, 'tests-red', 'lastTest: turn-close (step 2)');
  else {
    res.checked++;
    if (s.lastTest.isError === true) {
      const t = Date.parse(s.lastTest.ts) || now;
      add(2, 'tests-red', `Last test here failed (${testName(s.lastTest.cmd)}, ${ago(now - t)} ago): re-run and fix.`, 'me', '5 min', `${s.lastTest.ts}|${s.lastTest.cmd}`, now - t, 'last test failed');
    }
  }
  // 3 resume: the stored Next (ledger, or the transcript fallback) under 72 h
  if (s.next === undefined) skip(3, 'resume', 'no Next source: ledger next is turn-close (step 2), no readable transcript');
  else {
    res.checked++;
    const nx = s.next;
    const text = nx ? nextText(nx.text) : '';
    const owner = ownerOf(nx, now);
    const age = nx ? now - (Date.parse(nx.ts) || 0) : Infinity;
    if (text && owner !== 'none' && age < 72 * HOUR) {
      if (owner === 'hidden') res.hidden++;
      else add(3, 'resume', text, owner, '', text, age, clean(text, 60));
    }
  }
  // 4 handoff (D1)
  if (mk.handoff === undefined) skip(4, 'handoff', 'handoff index absent');
  else {
    res.checked++;
    const h = mk.handoff;
    if (h) add(4, 'handoff', h.slug ? `Load handoff ${h.slug} from ${day(h.createdMs)} (/handoff-load ${h.slug}).` : `Load the handoff bundle from ${day(h.createdMs)} (/handoff-load).`, 'me', '2 min', `${h.slug}|${h.createdMs}`, now - h.createdMs, `handoff ${h.slug || day(h.createdMs)}`);
  }
  // 5 syntax-left (D3); unchanged for 21 days = archived
  if (!Array.isArray(mk.syntax)) skip(5, 'syntax-left', 'diagnostics log absent');
  else {
    res.checked++;
    const live = mk.syntax.filter((x) => now - x.tsMs < 21 * DAY);
    res.archived += mk.syntax.length - live.length;
    const x = live[0];
    if (x) add(5, 'syntax-left', `${x.file} was left with a syntax error at ${day(x.tsMs)} ${hhmm(x.tsMs)}.`, 'me', '2 min', `${x.file}|${x.tsMs}`, now - x.tsMs, `${x.file} syntax error`);
  }
  // 6 commit-scoped: the last session's touched files that are still dirty
  if (!Array.isArray(s.touched)) skip(6, 'commit-scoped', 'touched: turn-close (step 2)');
  else if (!st.ok) skip(6, 'commit-scoped', `git status: ${st.why}`);
  else {
    res.checked++;
    const rel = (p) => normPath(path.isAbsolute(String(p)) && repo.top ? path.relative(repo.top, String(p)) : String(p));
    const dset = dirty.map((d) => normPath(d.path));
    const mine = [...new Set(s.touched.map(rel))].filter((p) => dset.some((d) => d === p || (d.endsWith('/') && p.startsWith(d)) || p.startsWith(d + '/'))).sort();
    if (mine.length) {
      add(6, 'commit-scoped', `Commit the ${mine.length} files the last session edited (${mine.slice(0, 5).map((p) => nameOnly(p, 80)).join(', ')}) by pathspec; ${Math.max(0, dirty.length - mine.length)} other dirty files left out. I draft the message.`, 'me', '2 min', mine.join('|'), 0, `${pl(mine.length, 'file')} to commit`);
    }
  }
  // 7 unpushed-clean
  if (!st.ok || !ah.ok) skip(7, 'unpushed-clean', !st.ok ? `git status: ${st.why}` : `ahead: ${ah.why}`);
  else {
    res.checked++;
    if (!dirty.length && ah.n > 0) {
      const text = repo.isAgnostic ? `Push ${pl(ah.n, 'commit')} on ${branch}: npm run doctor at 15 of 15, then git push and git push claude-harness.` : `Push ${pl(ah.n, 'commit')} on ${branch}.`;
      add(7, 'unpushed-clean', text, repo.deploysOnPush ? 'you' : 'me', '1 min', `${repo.head}|${ah.n}`, 0, `${ah.n} unpushed on ${branch}`);
    }
  }
  // 8 harness-red (digest, step 3)
  if (!s.digest || !Array.isArray(s.digest.red)) skip(8, 'harness-red', 'digest: not built (step 3)');
  else {
    res.checked++;
    const it = s.digest.red[0];
    if (it && repo.isHarness) add(8, 'harness-red', clean(it.text, 300), 'me', '5 min', it.hash || it.text, it.ageMs || 0, clean(it.text, 60));
  }
  // 9 stale-dirty: dirty files older than 7 days; unchanged for 21 days = archived
  if (!st.ok) skip(9, 'stale-dirty', `git status: ${st.why}`);
  else {
    res.checked++;
    const stale = dirty.filter((d) => d.mtimeMs && now - d.mtimeMs > 7 * DAY);
    if (stale.length) {
      const oldest = Math.min(...stale.map((d) => d.mtimeMs));
      const newest = Math.max(...stale.map((d) => d.mtimeMs));
      if (now - newest > 21 * DAY) res.archived++;
      else add(9, 'stale-dirty', `Decide the ${pl(stale.length, 'file')} left since ${day(oldest)}: commit, stash or drop; I draft the message.`, 'me', '3 min', `${stale.length}|${oldest}|${newest}`, now - oldest, `${pl(stale.length, 'file')} dirty since ${day(oldest)}`);
    }
  }
  // 10 open-task (D2): named by file and line only, never the item text
  res.checked++;
  const tasks = Array.isArray(mk.tasks) ? mk.tasks : [];
  if (tasks.length) {
    const total = tasks.reduce((a, t) => a + t.count, 0);
    const f = tasks[0];
    add(10, 'open-task', `Open task in ${f.file} (${total} unchecked in ${pl(tasks.length, 'file')}; first at line ${f.line}): read it and do the first item.`, 'me', '', `${f.file}|${f.count}|${f.mtimeMs}`, now - f.mtimeMs, `${total} open tasks in ${f.file}`);
  }

  res.matched = items.length;
  const demoted = s.demoted || {};
  const staleTop = s.staleTop || {};
  const me = [];
  for (const raw of items) {
    const it = { ...raw, ...hardStop(raw.text, raw.owner) };
    res.kinds[it.kind] = it.hash;
    if (RED_KINDS.has(it.kind)) res.red.push(it);
    if (it.owner === 'you') { res.leftForWes.push(it); continue; }
    if (demoted[it.kind] === 'demoted') { res.also.push(it); continue; }
    me.push(it);
  }
  // Stale-top: the same NEXT for 3 days with no `taken` drops below the next matching rung for 7 days.
  for (let i = 0; i < me.length - 1; i++) {
    if (staleTop[me[i].hash] > now) { const t = me[i]; me[i] = me[i + 1]; me[i + 1] = t; i++; }
  }
  res.next = me[0] || null;
  res.open = me.slice(1);
  return res;
}

// --- ledger bookkeeping ---

/** The first shown NEXT of each of the 3 previous days was this hash, and none was taken. */
function isStaleTop(rows, key, hash, now) {
  for (let d = 1; d <= 3; d++) {
    const want = day(now - d * DAY);
    const first = rows.find((r) => r.repo === key && r.outcome === 'shown' && day(Date.parse(r.ts)) === want);
    if (!first || first.hash !== hash) return false;
  }
  return !rows.some((r) => r.hash === hash && r.outcome === 'taken' && now - Date.parse(r.ts) < 4 * DAY);
}

/** A kind with 10+ shown in 14 days and a take rate under 20% is demoted; a restored kind is left alone. */
function demotions(rows, mutes, now) {
  const per = {};
  for (const r of rows) {
    if (!r.kind || !(now - Date.parse(r.ts) < 14 * DAY)) continue;
    const p = (per[r.kind] = per[r.kind] || { shown: 0, taken: 0 });
    if (r.outcome === 'shown') p.shown++;
    else if (r.outcome === 'taken') p.taken++;
  }
  const changed = [];
  for (const [kind, p] of Object.entries(per)) {
    if (p.shown >= 10 && p.taken / p.shown < 0.2 && !(mutes.kinds && mutes.kinds[kind])) {
      mutes.kinds = mutes.kinds || {};
      mutes.kinds[kind] = 'demoted';
      changed.push(kind);
    }
  }
  return changed;
}

/** taken when the previous NEXT's detector now reads green; ignored when unchanged with no commits; else still-open. */
function judge(lb, r, head) {
  if (!lb || !lb.kind || !lb.hash) return null;
  const checked = !r.skipped.some((x) => x.kind === lb.kind);
  if (checked && !r.kinds[lb.kind]) return 'taken';
  if (checked && r.kinds[lb.kind] === lb.hash && lb.head && lb.head === head) return 'ignored';
  return 'still-open';
}

function trimLedger(now) {
  try {
    if (fs.statSync(P.ledger).size < 1024 * 1024) return;
    const keep = jsonl(readText(P.ledger)).filter((r) => now - Date.parse(r.ts) < 90 * DAY);
    fs.writeFileSync(P.ledger, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  } catch (_) {}
}

function cleanSessions(now) {
  try { for (const f of fs.readdirSync(P.sessions)) { const p = path.join(P.sessions, f); if (now - (mtimeOf(p) || now) > 7 * DAY) try { fs.unlinkSync(p); } catch (_) {} } } catch (_) {}
}

// --- output ---

/**
 * Lines in display order within `cap`, with `last` (the USE line) reserved and always whole at the end.
 * Lines not marked keep drop from the bottom up and are counted in a "+N more" line; if the keep
 * lines alone still overflow, the longest one is shortened, never the tail.
 */
function compose(lines, cap, last = '') {
  const budget = cap - (last ? last.length + 1 : 0);
  const out = lines.filter((l) => l && l.text).map((l) => ({ ...l }));
  let dropped = 0;
  const body = () => [...out.map((l) => l.text), dropped ? `+${dropped} more not shown (1,400-char cap)` : ''].filter(Boolean).join('\n');
  for (let guard = 0; body().length > budget && guard < 100; guard++) {
    let i = out.length - 1;
    while (i >= 0 && out[i].keep) i--;
    if (i >= 0) { out.splice(i, 1); dropped++; continue; }
    let j = 0;
    for (let k = 1; k < out.length; k++) if (out[k].text.length > out[j].text.length) j = k;
    const len = Math.max(40, out[j].text.length - (body().length - budget) - 3);
    if (len >= out[j].text.length - 3) break;
    out[j].text = out[j].text.slice(0, len).trimEnd() + '...';
  }
  let text = body();
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - 3)) + '...';
  return last ? (text ? `${text}\n${last}` : last) : text;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).trimEnd() + '...' : s);

function answer(additionalContext, systemMessage) {
  const o = {};
  if (systemMessage) o.systemMessage = systemMessage;
  o.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext };
  return o;
}

/** SessionStart: the brief object, or null for no output. Never throws on a bad source. */
async function brief(evt, opts = {}) {
  const env = opts.env || process.env;
  const t0 = Date.now();
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli') return null;
  if (!evt || evt.hook_event_name !== 'SessionStart') return null;
  const source = String(evt.source || 'startup').toLowerCase();
  if (source === 'resume') return null;
  const OFF = answer('[opening-move] off (dashboard toggle)');
  if (isOff(env)) return OFF;
  const mutes = readJson(P.mutes, {});
  if (mutes.all === true) return OFF;
  const sid = String(evt.session_id || '');
  const found = findRepo(evt.cwd);
  if (!found) return source === 'compact' ? null : answer('[opening-move] fleet mode (no git repo at this cwd): digest: not built (step 3), 0 of 0 repos ranked; NEXT: none.');
  const top = found.top;
  const key = repoKey(top);
  const name = nameOnly(path.basename(top), 60);
  if (mutes.repos && mutes.repos[key]) return OFF;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const repoFile = path.join(P.repos, key + '.json');
  const rs = readJson(repoFile, {});
  const ring = ringOf(rs);
  const prev = ring.find((r) => r.session !== sid) || null;
  const prevMs = prev ? Date.parse(prev.ts) : 0;
  const since = prev ? prev.ts : new Date(now - DAY).toISOString();

  // A: three git calls in parallel; the fs sources below are read while git runs.
  const tg = Date.now();
  const gitP = Promise.all([
    git(['--no-optional-locks', 'log', `--since=${since}`, '-n', '200', '--format=%h%x09%ae'], top),
    git(['--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v1'], top),
    git(['--no-optional-locks', 'rev-list', '--count', '@{u}..HEAD'], top),
  ]);
  const head = gitHead(found.gitDir);
  const email = userEmail(head.common);
  // B: the ledger next (step 2), else the newest ring row's transcript tail.
  let next = rs.next && typeof rs.next === 'object' ? { ...rs.next, source: 'ledger' } : undefined;
  if (next === undefined && ring[0]) next = transcriptNext(ring[0].transcript_path);
  // D: half-done markers.
  const markers = { handoff: handoffMarker(top, prevMs, now), tasks: taskMarker(top, now), syntax: syntaxMarker(top) };
  const inbox = inboxMarker(name);
  const ledgerRows = jsonl(tail(P.ledger, 512 * 1024));
  const demotedNow = demotions(ledgerRows, mutes, now);

  const [logR, statusR, aheadR] = await gitP;
  const gitMs = Date.now() - tg;
  const calls = [['log', logR], ['status', statusR], ['rev-list', aheadR]];
  const gitOk = calls.filter(([, r]) => r.ok).length;
  const whys = calls.filter(([, r]) => !r.ok).map(([n, r]) => [n, r.why]);
  const gitPart = gitOk === 3 ? 'git 3 of 3' : `git ${gitOk} of 3 (${whys.length === 3 && new Set(whys.map((w) => w[1])).size === 1 ? whys[0][1] : whys.map(([n, w]) => `${n}: ${w}`).join('; ')})`;
  const commits = logR.ok ? logR.out.split('\n').filter((l) => l.trim()).map((l) => {
    const [h, ae] = l.split('\t');
    return { sha: /^[0-9a-f]{4,40}$/i.test(String(h).trim()) ? String(h).trim().slice(0, 12) : '?', mine: !!email && String(ae || '').trim().toLowerCase() === email };
  }) : null;
  const status = statusR.ok
    ? { ok: true, dirty: parseStatus(statusR.out).map((d, i) => ({ path: d.path, mtimeMs: i < STAT_MAX ? mtimeOf(path.join(top, d.path)) : null })) }
    : { ok: false, why: statusR.why };
  const ahead = aheadR.ok ? { ok: true, n: parseInt(aheadR.out.trim(), 10) || 0 } : { ok: false, why: aheadR.why };

  const repoInfo = { top, name, branch: head.branch, head: head.head, isAgnostic: name.toLowerCase() === 'agnostic-ai', isHarness: name.toLowerCase() === 'agnostic-ai' || normPath(top) === normPath(CLAUDE_HOME), deploysOnPush: deploysOnPush(top) };
  const staleTop = {};
  for (const [h, until] of Object.entries(rs.staleTop || {})) if (until > now) staleTop[h] = until;
  const state = {
    now, repo: repoInfo, git: { status, ahead },
    ci: undefined, digest: undefined, // digest.json: step 3
    lastTest: rs.lastTest && typeof rs.lastTest === 'object' ? rs.lastTest : undefined,
    touched: ring[0] && Array.isArray(ring[0].touched) ? ring[0].touched : undefined,
    next, markers, demoted: mutes.kinds || {}, staleTop,
  };
  let r = rank(state);
  if (r.next && !staleTop[r.next.hash] && isStaleTop(ledgerRows, key, r.next.hash, now)) {
    staleTop[r.next.hash] = now + 7 * DAY;
    r = rank({ ...state, staleTop });
  }
  const outcome = judge(rs.lastBrief, r, head.head);

  // Compose.
  const markerSrc = [['handoff index', markers.handoff !== undefined], ['tasks', true], ['diagnostics log', markers.syntax !== undefined], ['inbox', inbox !== undefined]];
  const missing = markerSrc.filter(([, ok]) => !ok).map(([n]) => `${n} absent`);
  const markerPart = `markers ${markerSrc.length - missing.length} of ${markerSrc.length}${missing.length ? ` (${missing.join(', ')})` : ''}`;
  const builtMs = Date.now() - t0;
  const headLine = `[opening-move] ${name} @ ${head.branch} ${head.head || '(no commits)'}. Built in ${builtMs} ms: ${gitPart} (${gitMs} ms), ring rows ${ring.length} of ${RING_MAX}, ${markerPart}, rules ${r.checked} of 10 checked; digest: not built (step 3); fixture: not built (UNVERIFIED).`;
  const lines = [{ text: headLine, keep: true }];
  if (commits && commits.length) {
    const mine = commits.filter((c) => c.mine);
    const other = commits.filter((c) => !c.mine);
    const shas = (l) => l.slice(0, 5).map((c) => c.sha).join(' ') + (l.length > 5 ? ` +${l.length - 5}` : '');
    const parts = [];
    if (mine.length) parts.push(`${mine.length} by your git user (${shas(mine)})`);
    if (other.length) parts.push(`${other.length} by another author (${shas(other)})`);
    const label = prev ? `SINCE last session here (${ago(now - prevMs)} ago)` : 'SINCE 24 h ago (no earlier session logged here)';
    lines.push({ text: `${label}: ${pl(commits.length, 'commit')}${commits.length >= 200 ? '+' : ''}: ${parts.join(', ')}${ahead.ok ? `; ${ahead.n} not pushed` : ''}.` });
  }
  const sibs = ring.filter((x) => x.session !== sid && now - Date.parse(x.ts) < SIBLING_MS);
  if (sibs.length) lines.push({ text: `LIVE SIBLING: ${sibs.length === 1 ? 'a session' : `${sibs.length} sessions`} prompted here ${ago(now - Date.parse(sibs[0].ts))} ago. Arm scope-lock on your files before editing.`, keep: true });
  if (inbox && inbox.n) lines.push({ text: `INBOX: ${inbox.n} of ${inbox.of} files in ~/clawd/agent-comms/inbox name ${name}; claim before touching.` });
  if (r.red.length) lines.push({ text: `RED: ${r.red.map((x) => x.short).join('; ')}.`, keep: true });
  if (r.leftForWes.length) {
    const more = r.leftForWes.length > 2 ? ` (+${r.leftForWes.length - 2} more)` : ''; // the count leads, so a shortened line keeps it
    lines.push({ text: `LEFT FOR WES${more}: ${r.leftForWes.slice(0, 2).map((x) => `${clip(x.text, 200)} [${x.kind}, rung ${x.rung}]`).join(' | ')}`, keep: true });
  }
  const openBits = r.open.map((x) => `${x.short} [${x.kind}]`);
  if (r.hidden) openBits.push(`${r.hidden} waiting (hidden until its date)`);
  if (openBits.length) lines.push({ text: `LEFT OPEN: ${openBits.join('; ')}.` });
  if (r.also.length) lines.push({ text: `also (demoted): ${r.also.map((x) => x.short).join('; ')}.` });
  if (r.archived) lines.push({ text: `archived: ${pl(r.archived, 'item')} unchanged for 21 d or more.` });
  const skipped = r.skipped.length ? `, ${r.skipped.length} skipped (source absent: ${r.skipped.map((x) => x.kind).join(', ')})` : '';
  const dirtyPart = status.ok ? `${status.dirty.length} dirty` : `dirty: unknown (${status.why})`;
  const aheadPart = ahead.ok ? `${ahead.n} unpushed` : `unpushed: unknown (${ahead.why})`;
  const nothing = !r.next && !r.leftForWes.length && !r.red.length && !r.open.length;
  let sys = '';
  if (nothing) {
    // No upstream means nothing to be ahead of: still clean, with the count printed as unknown.
    const isClean = status.ok && !status.dirty.length && (ahead.ok ? !ahead.n : ahead.why === 'no upstream');
    lines.push({ text: `${isClean ? 'clean (UNVERIFIED: fixture not built)' : 'no NEXT'}: ${dirtyPart}, ${aheadPart}, ${r.matched} of ${r.checked} NEXT rules matched${skipped}.`, keep: true });
  } else {
    if (r.next) {
      const chip = [r.next.kind, `rung ${r.next.rung}`, r.next.ageMs ? ago(r.next.ageMs) : null].filter(Boolean).join(', ');
      lines.push({ text: `NEXT (me) [${chip}]: ${r.next.text}${r.next.est ? ` About ${r.next.est}.` : ''}`, keep: true });
    } else {
      lines.push({ text: 'NEXT (me): none. On "go", prepare the LEFT FOR WES item and stop.', keep: true });
    }
    lines.push({ text: `rules: ${r.matched} of ${r.checked} matched${skipped}; ${dirtyPart}, ${aheadPart}.` });
    const headline = `Opening move, ${name}: ${r.red.length} red${r.leftForWes.length ? `, ${r.leftForWes.length} left for Wes` : ''}`;
    if (r.next) sys = `${headline}. Type go to start: ${clean(r.next.short || r.next.text, 90)}${r.next.est ? `, about ${r.next.est}` : ''}.`;
    else if (r.leftForWes.length) sys = `${headline} (prepare only): ${clean(r.leftForWes[0].short || r.leftForWes[0].text, 90)}.`;
    else sys = `${headline}.`;
  }

  let ctx;
  if (source === 'compact') {
    if (!r.red.length && !r.next) return null;
    const bits = [`[opening-move] ${name} @ ${head.branch} ${head.head || ''} (after compact).`];
    if (r.red.length) bits.push(`RED: ${r.red.map((x) => x.short).join('; ')}.`);
    if (r.next) bits.push(`NEXT (me) [${r.next.kind}]: ${r.next.text}`);
    ctx = bits.join(' ');
    if (ctx.length > COMPACT_CAP) ctx = ctx.slice(0, COMPACT_CAP - 3) + '...';
    sys = '';
  } else {
    ctx = compose(lines, CAP, nothing ? '' : USE_LINE);
  }

  // Writes: session briefNext, lastBrief, ledger rows, seen.json. Each wrapped.
  const bn = r.next || r.leftForWes[0] || null;
  if (sid) {
    const sf = sidFile(sid);
    const ses = readJson(sf, {});
    ses.repo = key;
    ses.briefTs = nowIso;
    ses.briefNext = bn ? { text: bn.text, owner: bn.owner, kind: bn.kind, hash: bn.hash, ts: nowIso } : null;
    writeJson(sf, ses);
  }
  const fresh = readJson(repoFile, {}); // re-read: a sibling's prompt may have added a ring row meanwhile
  fresh.repo = top;
  fresh.lastBrief = { ts: nowIso, kind: bn ? bn.kind : null, hash: bn ? bn.hash : null, owner: bn ? bn.owner : null, head: head.head };
  fresh.staleTop = staleTop;
  writeJson(repoFile, fresh);
  if (outcome) appendLine(P.ledger, { ts: nowIso, repo: key, kind: rs.lastBrief.kind, hash: rs.lastBrief.hash, outcome });
  for (const k of demotedNow) appendLine(P.ledger, { ts: nowIso, repo: key, kind: k, hash: null, outcome: 'auto-demoted' });
  if (demotedNow.length) writeJson(P.mutes, mutes);
  if (bn) appendLine(P.ledger, { ts: nowIso, repo: key, kind: bn.kind, hash: bn.hash, outcome: 'shown' });
  const shown = [r.next, ...r.leftForWes].filter(Boolean);
  if (shown.length) {
    const seen = readJson(P.seen, {});
    for (const h of Object.keys(seen)) if (!(now - Date.parse(seen[h]) < 90 * DAY)) delete seen[h];
    for (const it of shown) seen[it.hash] = nowIso;
    writeJson(P.seen, seen);
  }
  trimLedger(now);
  cleanSessions(now);
  return answer(ctx, sys);
}

// --- UserPromptSubmit: the CHAIN half ---

function freshNext(nx, now, maxAge) {
  if (!nx || typeof nx !== 'object' || !clean(nx.text)) return null;
  return now - (Date.parse(nx.ts) || 0) < maxAge ? nx : null;
}

/** Shadow precision measure (spec 2.3 step 3): a would-block followed by a "did you test" prompt. */
function nudge(sid, prompt, now) {
  if (!NUDGE_RE.test(String(prompt || ''))) return;
  const rows = jsonl(tail(P.turnClose, 64 * 1024));
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.session !== sid || r.nudged) continue;
    if (r.wouldBlock === true) appendLine(P.turnClose, { ts: new Date(now).toISOString(), session: sid, nudged: true });
    return;
  }
}

/** Returns the additionalContext to inject ('' = nothing). Same contract as wakeup-guard.main. */
function main(evt, opts = {}) {
  const env = opts.env || process.env;
  if (env.CLAUDE_CODE_ENTRYPOINT !== 'cli') return '';
  if (!evt || evt.hook_event_name !== 'UserPromptSubmit') return '';
  if (isMachineTurn(evt)) return '';
  if (isOff(env)) return '';
  const sid = String(evt.session_id || '').trim();
  // A prompt with no transcript is not a Claude Code session (a probe or a hand run): no ring row.
  if (!sid || !evt.transcript_path) return '';
  const found = findRepo(evt.cwd);
  if (!found) return '';
  const key = repoKey(found.top);
  const mutes = readJson(P.mutes, {});
  if (mutes.all === true || (mutes.repos && mutes.repos[key])) return '';
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Ring row: one per session, newest first, at most 5; touched/tainted from turn-close survive.
  const repoFile = path.join(P.repos, key + '.json');
  const rs = readJson(repoFile, {});
  const ring = ringOf(rs);
  const old = ring.find((r) => r.session === sid);
  const row = { ...(old || {}), session: sid, transcript_path: String(evt.transcript_path), cwd: String(evt.cwd || ''), ts: nowIso, source: 'prompt' };
  rs.repo = found.top;
  rs.ring = [row, ...ring.filter((r) => r.session !== sid)].slice(0, RING_MAX);
  writeJson(repoFile, rs);

  nudge(sid, evt.prompt, now);

  // Go binding: the WHOLE prompt must be a continuation word.
  const sfile = sidFile(sid);
  const ses = readJson(sfile, {});
  const first = !(ses.prompts > 0);
  ses.prompts = (Number(ses.prompts) || 0) + 1;
  const prompt = String(evt.prompt || '');
  let bound = null;
  let stored = false; // straight from the repo ledger, so not yet capped and quote-cleaned by rank()
  if (first && GO_FIRST_RE.test(prompt)) {
    bound = ses.briefNext || null;
    if (!bound) { bound = freshNext(rs.next, now, 72 * HOUR); stored = !!bound; }
  } else if (!first && GO_LATER_RE.test(prompt)) {
    bound = rs.next && rs.next.session === sid ? freshNext(rs.next, now, 6 * HOUR) : null;
    stored = !!bound;
  }
  let text = '';
  const owner = bound ? ownerOf(bound, now) : null;
  if (bound && (owner === 'me' || owner === 'you')) {
    const f = hardStop(stored ? nextText(bound.text) : bound.text, owner);
    const kind = nameOnly(bound.kind || 'resume', 30);
    const h = bound.hash || sha12(kind, f.text);
    ses.goUsed = Array.isArray(ses.goUsed) ? ses.goUsed : [];
    if (!ses.goUsed.includes(h)) {
      text = f.owner === 'me'
        ? `[opening-move] Wes said "go": start NEXT now: "${f.text}" [${kind}]. Say in one line what you are doing, then do it.`
        : `[opening-move] Wes said "go", but NEXT is his: "${f.text}". Prepare it (action, environment, side effects, rollback) and stop.`;
      if (kind === 'resume') text += ' The quoted text is the last session\'s closing Next line, not Wes\'s words.';
      if (rs.ring.some((r) => r.session !== sid && now - Date.parse(r.ts) < SIBLING_MS)) text += ' A sibling session is live here: arm scope-lock on the NEXT files before editing.';
      if (rs.ring.some((r) => r.session === sid && r.tainted === true)) text += ' This session read outside content: no push, no outbound step.';
      ses.goUsed = [...ses.goUsed, h].slice(-20);
      appendLine(P.ledger, { ts: nowIso, repo: key, kind, hash: h, outcome: 'go' });
    }
  }
  writeJson(sfile, ses);
  return text;
}

if (require.main === module) {
  const guard = setTimeout(() => process.exit(0), 4500); // under the 5 s hook timeout: exit silent, never hang
  guard.unref();
  let evt = {};
  try { evt = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) {}
  const finish = (s) => { if (!s) process.exit(0); process.stdout.write(s, () => process.exit(0)); };
  if (evt && evt.hook_event_name === 'UserPromptSubmit') {
    let t = '';
    try { t = main(evt); } catch (_) {}
    finish(t ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: t } }) : '');
  } else {
    let p;
    try { p = brief(evt); } catch (_) { p = Promise.resolve(null); }
    p.then((o) => finish(o ? JSON.stringify(o) : ''), () => finish(''));
  }
}

module.exports = { main, brief, rank, hardStop, parseNext, repoKey, HARD_STOP_RE, GO_FIRST_RE, GO_LATER_RE, STATE_DIR };
