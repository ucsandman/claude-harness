// freeze.cjs — the frozen guard fileset: what is protected, and its content hashes.
// Shared by gates.cjs (the `gate-freeze` check and `--lock`) and hooks/gate-freeze.cjs
// (the write deny). A run that can rewrite its own evaluator writes itself to PASS;
// this is the list of evaluators. Ported from ELAI's gate_freeze_check (rule R8), 2026-09-06.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/');
const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const MANIFEST = path.join(__dirname, 'gate-manifest.json');
const LOCK = path.join(__dirname, 'gate-manifest.lock.json');

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
const expand = (p) => norm(p.replace(/^~(?=\/|$)/, HOME).replace(/^(?![A-Za-z]:|\/)/, ROOT + '/'));

function manifest() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return { harnessRoots: (m.harnessRoots || []).map(expand), frozen: m.frozen || [] };
}

// Resolve one manifest entry. `settings.json#hooks` is virtual: its content is the canonical
// JSON of that key, so a permissions edit never trips it and a hook edit always does.
function resolveEntry(entry) {
  const [file, key] = entry.split('#');
  const abs = expand(file);
  if (key) return [{ id: entry, abs, key }];
  const base = path.basename(abs);
  if (!base.includes('*')) return [{ id: entry, abs }];
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return fs.readdirSync(dir).filter((f) => re.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ id: entry, abs: norm(path.join(dir, f)) }));
}

function frozenFiles() {
  const out = [];
  for (const e of manifest().frozen) out.push(...resolveEntry(e));
  return out;
}

function contentOf(f) {
  if (!fs.existsSync(f.abs)) return null;
  const text = fs.readFileSync(f.abs, 'utf8');
  if (!f.key) return text;
  try { return JSON.stringify(JSON.parse(text)[f.key] ?? null); } catch { return text; }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

// {abs → hash} for every frozen file present right now (a missing file has hash 'MISSING').
function currentHashes() {
  const out = {};
  for (const f of frozenFiles()) {
    const c = contentOf(f);
    out[f.key ? `${f.abs}#${f.key}` : f.abs] = c === null ? 'MISSING' : sha(c);
  }
  return out;
}
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}
// Compare live hashes to the lock. Returns {changed, added, removed, count}.
function drift() {
  const lock = readLock();
  const now = currentHashes();
  if (!lock) return { noLock: true, changed: [], added: Object.keys(now), removed: [], count: Object.keys(now).length };
  const changed = Object.keys(now).filter((k) => k in lock.files && lock.files[k] !== now[k]);
  const added = Object.keys(now).filter((k) => !(k in lock.files));
  const removed = Object.keys(lock.files).filter((k) => !(k in now));
  return { noLock: false, changed, added, removed, count: Object.keys(now).length, lockedAt: lock.lockedAt };
}
function writeLock(note) {
  const d = drift();
  const files = currentHashes();
  fs.writeFileSync(LOCK, JSON.stringify({
    _comment: 'Content hashes of the frozen guard fileset (tools/gates/gate-manifest.json). The gate-freeze check fails on any drift; re-record deliberately with `node tools/gates/gates.cjs --lock` from a harness session after reviewing the change.',
    lockedAt: new Date().toISOString(), files,
  }, null, 2) + '\n', 'utf8');
  try {
    const dir = path.join(HOME, '.claude', 'logs'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gate-freeze.log'), `${new Date().toISOString()}\tlock\tchanged=${d.changed.length} added=${d.added.length} removed=${d.removed.length}\t${note || ''}\t${[...d.changed, ...d.added, ...d.removed].map((p) => path.basename(p)).join(' ')}\n`);
  } catch { /* logging is best effort */ }
  return d;
}
// Is `p` (absolute or relative to cwd) a frozen file? Returns the entry or null.
function frozenEntryFor(p, cwd) {
  const abs = norm(path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p));
  return frozenFiles().find((f) => f.abs === abs) || null;
}
function inHarnessRoot(cwd) {
  const c = norm(cwd || process.cwd()) + '/';
  return manifest().harnessRoots.some((r) => c.startsWith(r + '/'));
}

module.exports = { manifest, frozenFiles, currentHashes, drift, writeLock, frozenEntryFor, inHarnessRoot, LOCK, MANIFEST, norm };
