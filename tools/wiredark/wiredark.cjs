#!/usr/bin/env node
// wiredark.cjs — a new exported function with no production caller is not shipped.
//
// The failure it watches: an agent adds a function AND its unit test in one change,
// the test calls the function directly, everything is green, and no real entrypoint
// ever reaches it. Prose rules ("wire it in the same change") only reduce the rate;
// a deterministic check over the changeset removes it. Ported from the
// production-caller gate in DITlieD/ELAI-archive (rules R6/R7), 2026-09-06.
//
//   node wiredark.cjs                 staged changes (pre-commit default)
//   node wiredark.cjs --files a,b     named files, working tree
//   node wiredark.cjs --json          machine output
//   WIREDARK=off                      skip for one shell session
//
// Verdicts per NEW exported symbol (added lines only, non-test files only):
//   WIRED            a non-test, non-import reference exists outside the defining file
//   REEXPORTED       only an `export ... from` barrel reaches it (library surface) — warn
//   INTERNAL         only same-file references (a helper, or a main() block)       — warn
//   REGISTERED-DARK  a `WIRE-DARK[<why>]` comment sits within 3 lines above it     — warn
//   DARK-TYPE        a type/interface/enum used nowhere else                         — warn
//   DARK             a function/class/const with zero production references         — BLOCK
// Exit 0 clean (warns allowed), 1 any DARK, 2 the scan itself failed (fail closed).
// The verdict line always carries the volume scanned (rule L2).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|fixtures|__mocks__|e2e|cypress|playwright)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$|(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor|skills-archive|target)\//;
const DECL_ONLY = /\.d\.ts$/;
// Framework entrypoints are reached by the runtime, never by in-repo code.
const ENTRY_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'middleware', 'config', 'metadata',
  'generateMetadata', 'generateStaticParams', 'generateSitemaps', 'generateImageMetadata', 'dynamic', 'revalidate', 'runtime',
  'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'loader', 'action', 'handler', 'main', 'register', 'activate',
  'deactivate', 'setup', 'load', 'lambdaHandler', 'app', 'viewport']);
const ENTRY_FILES = /(^|\/)(app|pages|api|routes)\/.*\.(ts|tsx|js|jsx|mjs)$|(^|\/)(middleware|instrumentation|next\.config|vite\.config|vitest\.config|jest\.config|playwright\.config|tailwind\.config|eslint\.config|postcss\.config|svelte\.config|astro\.config|wrangler|manage|setup|conftest)\.[cm]?[jt]sx?$|(^|\/)(manage|setup|wsgi|asgi|__main__)\.py$/;
const IMPORT_LINE = /^\s*(import\b|export\s+(type\s+)?\{[^}]*\}\s+from\b|export\s+\*|from\s+\S+\s+import\b|const\s+\{[^}]*\}\s*=\s*require\(|const\s+\w+\s*=\s*require\()/;
const REEXPORT_LINE = /^\s*export\s+(type\s+)?(\{[^}]*\}|\*)(\s+as\s+\w+)?\s+from\b/;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;
const MARKER = /WIRE-DARK\[[^\]]+\]/;

// One added line → the exported symbol it declares, or null.
function declaredSymbol(line, file) {
  if (/\.py$/.test(file)) {
    const m = /^(?:async\s+)?(def|class)\s+([A-Za-z]\w*)\s*[(:]/.exec(line); // column 0 only
    return m && !m[2].startsWith('_') ? { name: m[2], kind: m[1] === 'class' ? 'class' : 'fn' } : null;
  }
  let m = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (m) return { name: m[3], kind: /type|interface|enum/.test(m[2]) ? 'type' : m[2] === 'class' ? 'class' : 'fn' };
  m = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (m) return { name: m[1], kind: 'fn' };
  return null;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

// {file → {added: Set<lineNo>, lines: string[]}} for the files under scan.
function changedFiles(files) {
  const out = new Map();
  const diffArgs = files ? ['diff', '-U0', '--no-color', '--', ...files] : ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR'];
  const diff = git(diffArgs);
  let file = null;
  for (const raw of diff.split('\n')) {
    let m;
    if ((m = /^\+\+\+ b\/(.+)$/.exec(raw))) { file = m[1]; if (!out.has(file)) out.set(file, { added: new Set(), text: null }); continue; }
    if (/^\+\+\+ \/dev\/null/.test(raw)) { file = null; continue; }
    if (file && (m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw))) {
      const start = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < n; i++) out.get(file).added.add(start + i);
    }
  }
  // Untracked files named explicitly: every line is new.
  for (const f of files || []) {
    if (out.has(f) || !fs.existsSync(f)) continue;
    let tracked = true;
    try { git(['ls-files', '--error-unmatch', '--', f]); } catch { tracked = false; }
    if (!tracked) out.set(f, { added: null, text: null });
  }
  for (const [f, rec] of out) {
    try { rec.text = files ? fs.readFileSync(f, 'utf8') : git(['show', ':' + f]); } catch { rec.text = ''; }
    if (rec.added === null) rec.added = new Set(rec.text.split('\n').map((_, i) => i + 1));
  }
  return out;
}

// Production references to `name` across the index (staged state), excluding the defining file and tests.
function references(name, definingFile, staged) {
  let hits;
  try {
    hits = git(['grep', staged ? '--cached' : '-I', '-n', '-w', '-I', '-e', name, '--', ...['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.svelte', '*.vue', '*.astro', '*.html']]);
  } catch (e) { if (e.status === 1) return { prod: 0, reexport: 0, self: 0 }; throw e; }
  const r = { prod: 0, reexport: 0, self: 0 };
  for (const h of hits.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(h);
    if (!m) continue;
    const [, file, , line] = m;
    if (TEST_PATH.test(file) || DECL_ONLY.test(file) || COMMENT_LINE.test(line)) continue;
    if (file === definingFile) { if (!declaredSymbol(line, file)) r.self++; continue; }
    if (REEXPORT_LINE.test(line)) { r.reexport++; continue; }
    if (IMPORT_LINE.test(line)) continue;
    r.prod++;
  }
  return r;
}

function scan({ files = null } = {}) {
  const staged = !files;
  const findings = [];
  const changed = changedFiles(files);
  let filesScanned = 0;
  for (const [file, rec] of changed) {
    if (!CODE.test(file) || TEST_PATH.test(file) || DECL_ONLY.test(file)) continue;
    filesScanned++;
    const lines = rec.text.split('\n');
    const entryFile = ENTRY_FILES.test(file);
    // A declaration line that merely changed (new signature, new body on one line) is not a new symbol:
    // only a name absent from HEAD's version of the file counts.
    const before = new Set();
    try { for (const l of git(['show', 'HEAD:' + file]).split('\n')) { const s = declaredSymbol(l, file); if (s) before.add(s.name); } } catch { /* new file */ }
    for (const ln of rec.added) {
      const sym = declaredSymbol(lines[ln - 1] || '', file);
      if (!sym || before.has(sym.name)) continue;
      if (ENTRY_NAMES.has(sym.name) || (entryFile && /^(default|Page|Layout|Route|Component)$/.test(sym.name))) continue;
      const above = lines.slice(Math.max(0, ln - 4), ln - 1).join('\n');
      const refs = references(sym.name, file, staged);
      let verdict;
      if (refs.prod > 0) verdict = 'WIRED';
      else if (MARKER.test(above)) verdict = 'REGISTERED-DARK';
      else if (refs.reexport > 0) verdict = 'REEXPORTED';
      else if (refs.self > 0) verdict = 'INTERNAL';
      else verdict = sym.kind === 'type' ? 'DARK-TYPE' : 'DARK';
      findings.push({ file, line: ln, name: sym.name, kind: sym.kind, verdict, refs });
    }
  }
  const dark = findings.filter((f) => f.verdict === 'DARK');
  return { filesScanned, symbols: findings.length, findings, dark: dark.length, ok: dark.length === 0 };
}

function main(argv) {
  if (/^(off|0|false)$/i.test(process.env.WIREDARK || '')) { console.log('wiredark: skipped (WIREDARK=off)'); return 0; }
  const json = argv.includes('--json');
  const fi = argv.indexOf('--files');
  let files = fi >= 0 ? String(argv[fi + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  let res;
  try {
    // Every path git reports is repo-relative with forward slashes; work from the top level so ours match.
    const top = git(['rev-parse', '--show-toplevel']).trim();
    if (files) files = files.map((f) => path.relative(top, path.resolve(f)).split(path.sep).join('/'));
    process.chdir(top);
    res = scan({ files });
  } catch (e) {
    if (json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(`wiredark: scan failed, refusing to pass on an unscanned change: ${e.message.split('\n')[0]}`);
    return 2;
  }
  if (json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 1; }
  const tally = {};
  for (const f of res.findings) tally[f.verdict] = (tally[f.verdict] || 0) + 1;
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'no new exports';
  console.log(`wiredark: ${res.symbols} new export(s) in ${res.filesScanned} file(s) scanned: ${summary}`);
  for (const f of res.findings) {
    if (f.verdict === 'WIRED') continue;
    const tag = f.verdict === 'DARK' ? '  ✗' : '  ~';
    console.log(`${tag} ${f.verdict.padEnd(15)} ${f.file}:${f.line}  ${f.name}`);
  }
  if (!res.ok) {
    console.log('\n  A new export with no production caller is not shipped. Wire it into a real entrypoint in this change,');
    console.log('  or, if it must ship dark (a consumer lands in a named later step), put this on the line above it:');
    console.log('      // WIRE-DARK[<why + where the consumer lands>]');
    console.log('  Off for one shell session: WIREDARK=off');
  }
  return res.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scan, declaredSymbol };
