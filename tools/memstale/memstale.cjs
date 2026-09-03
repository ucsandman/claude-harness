#!/usr/bin/env node
'use strict';

/*
 * memstale.cjs — provenance check for institutional memory.
 *
 * Every memory file names things it was true about: files, directories,
 * scripts, flags. Recall reads them as current. This tool checks every
 * absolute path a memory mentions against the disk and reports the volume
 * it touched (L2: a verdict carries its count). With --mark it writes a
 * `stale-since: YYYY-MM-DD` line into the memory's frontmatter (and removes
 * it again once every path resolves). It never deletes a memory: a stale
 * memory is still evidence of what was once true.
 *
 * Stores:
 *   1. C:\Users\<me>\.claude\projects\<slug>\memory\*.md   (auto-memory)
 *   2. C:\Users\<me>\.agents\memory\**\*.md                 (agents-memory)
 *
 * Usage:
 *   node memstale.cjs              # report only
 *   node memstale.cjs --mark       # also write/clear stale-since markers
 *   node memstale.cjs --json       # machine-readable
 *   node memstale.cjs --quiet      # one summary line
 *
 * Exit code is 0 always; the summary line is the verdict.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// MEMSTALE_HOME points the store roots elsewhere (tests, L1 probes); path
// resolution inside memories still uses the real home.
const HOME = os.homedir();
const STORE_HOME = process.env.MEMSTALE_HOME || HOME;
const STORES = [
  { name: 'auto-memory', root: path.join(STORE_HOME, '.claude', 'projects'), pick: (root) => {
    const out = [];
    for (const slug of safeList(root)) {
      const dir = path.join(root, slug, 'memory');
      for (const f of safeList(dir)) if (f.endsWith('.md') && f !== 'MEMORY.md') out.push(path.join(dir, f));
    }
    return out;
  } },
  { name: 'agents-memory', root: path.join(STORE_HOME, '.agents', 'memory'), pick: (root) => walk(root).filter((f) => f.endsWith('.md')) },
];

// Paths a memory can name. Windows absolute (both slash styles), tilde-home,
// and MSYS /c/... . Trailing punctuation and markdown closers are trimmed.
// Drive letter must not be preceded by a word character, or `https://x` reads
// as `s://x` (2026-09-03 first run: 200 of 265 misses were URLs).
const PATH_RE = /(?:(?<![A-Za-z0-9])[A-Z]:[\\/][^\s`"'<>|()\[\]{}*,;]+|(?<![A-Za-z0-9])~[\\/][^\s`"'<>|()\[\]{}*,;]+|(?<![A-Za-z0-9])\/[a-z]\/[^\s`"'<>|()\[\]{}*,;]+)/g;
// Skip things that look like paths but are not on this disk by design:
// env files, temp dirs, placeholders (`...`, `x.sh`, `your.db`, `<slug>`),
// prefixes that end in `-`/`_`/`.`, and anything carrying a control byte.
// `C:\Program Files\Git\team` is Git Bash rewriting a URL path (`/team`) into
// its install dir; memories that quote such a mangled path are not stale.
const SKIP_RE = /\.env(\.example)?$|\.secrets|[\\/]tmp[\\/]|\bnode_modules\b|<[^>]+>|\$\{|\.\.\.|[\\/](x|X|your[.\w]*|x\.\w+)$|[-_.]$|[\x00-\x1f\x7f]|^C:[\\/]Program Files[\\/]Git[\\/]/i;
const DRIVE_OK = {};
function driveExists(p) {
  const d = p.slice(0, 1).toUpperCase();
  if (!(d in DRIVE_OK)) DRIVE_OK[d] = exists(d + ':\\');
  return DRIVE_OK[d];
}
// `C:\Program Files\x` and `C:\Projects\Practical Systems\y` split on the space.
// When the bare match is missing, try re-joining up to three following words.
function extendAcrossSpaces(p, rest) {
  const words = rest.match(/^((?: [A-Za-z0-9][^\s`"'<>|()\[\]{}*,;]*){1,3})/);
  if (!words) return null;
  const parts = words[1].trim().split(' ');
  let best = null; // longest candidate whose parent exists: reported in full when nothing resolves
  for (let i = 1; i <= parts.length; i++) {
    const cand = normalize(p + ' ' + parts.slice(0, i).join(' '));
    if (exists(cand)) return cand;
    if (exists(path.dirname(cand))) best = cand;
  }
  return best;
}

const argv = process.argv.slice(2);
const MARK = argv.includes('--mark');
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const TODAY = new Date().toISOString().slice(0, 10);

function safeList(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}
function walk(dir) {
  const out = [];
  for (const name of safeList(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function normalize(raw) {
  let p = raw.replace(/[.,;:)\]]+$/, '');
  if (p.startsWith('~')) p = HOME + p.slice(1);
  const msys = p.match(/^\/([a-z])\/(.*)$/);
  if (msys) p = msys[1].toUpperCase() + ':\\' + msys[2];
  // A `file:line` reference: drop the line suffix.
  p = p.replace(/:\d+(-\d+)?$/, '');
  return p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch (e) { return false; }
}
function isEnvFile(p) {
  return /(^|[\\/])\.env(\..*)?$|\.secrets\.env$/i.test(p);
}

function checkMemory(file) {
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  const missing = [];
  let checked = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    if (SKIP_RE.test(raw)) continue;
    let p = normalize(raw);
    if (p.length < 6 || seen.has(p) || isEnvFile(p) || !driveExists(p)) continue;
    if (!exists(p)) {
      const ext = extendAcrossSpaces(raw, text.slice(m.index + m[0].length, m.index + m[0].length + 80));
      if (ext) p = ext;
    }
    if (seen.has(p) || SKIP_RE.test(p)) continue; // re-test: space re-joining can complete a skipped prefix
    seen.add(p);
    checked++;
    if (!exists(p)) missing.push(p);
  }
  return { file, checked, missing, text };
}

// Frontmatter marker. Placed as the last line before the closing ---, as a
// top-level key so recall.cjs's single-line reader can pick it up later.
function currentMarker(text) {
  const m = text.match(/^stale-since:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}
function withMarker(text, date) {
  if (!text.startsWith('---')) return text; // no frontmatter: leave the body alone
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const stripped = text.slice(0, end).replace(/\nstale-since:.*$/m, '');
  const head = date ? stripped + '\nstale-since: ' + date : stripped;
  return head + text.slice(end);
}

const report = { date: TODAY, stores: [], memories: 0, checked: 0, missing: 0, stale: [], cleared: [], marked: 0 };
for (const store of STORES) {
  const files = store.pick(store.root);
  const s = { name: store.name, root: store.root, memories: files.length, checked: 0, missing: 0 };
  for (const f of files) {
    if (isEnvFile(f)) continue;
    const r = checkMemory(f);
    s.checked += r.checked; s.missing += r.missing.length;
    const had = currentMarker(r.text);
    const rel = path.relative(HOME, f);
    if (r.missing.length) {
      report.stale.push({ file: rel, checked: r.checked, missing: r.missing, staleSince: had || (MARK ? TODAY : null) });
      if (MARK && !had) { fs.writeFileSync(f, withMarker(r.text, TODAY)); report.marked++; }
    } else if (had) {
      report.cleared.push(rel);
      if (MARK) fs.writeFileSync(f, withMarker(r.text, null));
    }
  }
  report.memories += s.memories; report.checked += s.checked; report.missing += s.missing;
  report.stores.push(s);
}

const verdict = report.missing === 0 ? 'OK' : 'STALE';
const summary = `memstale ${verdict} memories=${report.memories} paths_checked=${report.checked} missing=${report.missing} stale_memories=${report.stale.length}` +
  (MARK ? ` marked=${report.marked} cleared=${report.cleared.length}` : '') + (report.checked === 0 ? '  (checked nothing: that is not a pass)' : '');

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, ...report }, null, 1));
} else {
  console.log(summary);
  if (!QUIET) {
    for (const s of report.stores) console.log(`  ${s.name}: memories=${s.memories} paths=${s.checked} missing=${s.missing}`);
    for (const m of report.stale) {
      console.log(`  ${m.file}${m.staleSince ? ' (stale-since ' + m.staleSince + ')' : ''}`);
      for (const p of m.missing) console.log(`      missing ${p}`);
    }
    if (report.cleared.length) console.log('  cleared (all paths resolve again): ' + report.cleared.join(', '));
    if (!MARK && report.stale.length) console.log('  run with --mark to write stale-since markers (never deletes)');
  }
}
