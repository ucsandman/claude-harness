#!/usr/bin/env node
// tests/run.cjs — self-test for skillfind.cjs.
// Builds a fixture tree, then asserts the scanner's parse rules, counters,
// tier classification, dedup, cache, scoring, CLI, --body safety rule, and
// the generated HTML page.

'use strict';

const fs = require('fs');
const path = require('path');
const sf = require('../skillfind.cjs');

let pass = 0, fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fx = path.join(__dirname, 'fixture');
function skill(rel, front, body = '# body\n') {
  const p = path.join(fx, rel, 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, front === null ? body : `---\n${front}\n---\n\n${body}`);
  return p;
}

fs.rmSync(fx, { recursive: true, force: true });
skill('good', 'name: good-one\ndescription: a normal skill for testing');
skill('longfm', `name: long-one\ndescription: ${'x'.repeat(5000)}`);
skill('nofm', null);
skill('node_modules/vendored', 'name: vendored\ndescription: must be skipped');
skill('quoted', 'name: "quoted-one"\ndescription: "a YAML-quoted scalar"');
skill('halfquote', 'name: half-one\ndescription: says "hello" mid-sentence');
skill('literal', 'name: literal-one\ndescription: |\n  a literal block scalar\n  across two lines');
skill('folded', 'name: folded-one\ndescription: >-\n  a folded block scalar\n  across two lines');
skill('wrapped', 'name: wrapped-one\ndescription:\n  "a quoted value that wraps\n  onto the next line"');
skill('nodesc', 'name: nodesc-one');

console.log('\n--- Task 1: scanner ---');
const { records, stats } = sf.scanRoot(fx);
const names = records.map(r => r.name).sort();

check('indexes a normal skill', names.includes('good-one'));
check('4KB fallback indexes >4096-byte frontmatter', names.includes('long-one'),
  `frontmatter fallback failed; got ${JSON.stringify(names)}`);
check('skips node_modules', !names.includes('vendored'));
check('counts node_modules skips', stats.skippedNodeModules === 1, `got ${stats.skippedNodeModules}`);
check('counts the long-frontmatter fallback', stats.longFallback === 1, `got ${stats.longFallback}`);
check('counts unparseable frontmatter', stats.unparseable === 1, `got ${stats.unparseable}`);

// Regression: 3 names and 76 descriptions on this machine are YAML-quoted.
// An unstripped quote leaks into both ranking and rendered output.
const quoted = records.find(r => r.name === 'quoted-one');
check('strips surrounding quotes from a quoted name', !!quoted,
  `got ${JSON.stringify(records.map(r => r.name))}`);
check('strips surrounding quotes from a quoted description',
  quoted && quoted.description === 'a YAML-quoted scalar',
  quoted && JSON.stringify(quoted.description));
const half = records.find(r => r.name === 'half-one');
check('leaves inner quotes alone',
  half && half.description === 'says "hello" mid-sentence',
  half && JSON.stringify(half.description));

// Regression: 38 descriptions on this machine are YAML block scalars. Read
// naively they become the literal string "|" or ">", dropping 10% of the
// corpus out of description search. The rendered page caught this; tests did not.
const lit = records.find(r => r.name === 'literal-one');
check('reads a literal (|) block scalar',
  lit && lit.description === 'a literal block scalar across two lines',
  lit && JSON.stringify(lit.description));
const fold = records.find(r => r.name === 'folded-one');
check('reads a folded (>-) block scalar',
  fold && fold.description === 'a folded block scalar across two lines',
  fold && JSON.stringify(fold.description));
const wrap = records.find(r => r.name === 'wrapped-one');
check('reads a bare key whose quoted value wraps onto the next lines',
  wrap && wrap.description === 'a quoted value that wraps onto the next line',
  wrap && JSON.stringify(wrap.description));
const nod = records.find(r => r.name === 'nodesc-one');
check('a genuinely absent description stays empty, not undefined',
  nod && nod.description === '', nod && JSON.stringify(nod.description));

// L1 fail-on-purpose: prove the unreadable counter can actually count.
const boom = sf.scanRoot(fx, { readFileFull: () => { throw new Error('EACCES'); } });
check('unreadable counter counts when reads throw', boom.stats.unreadable >= 1,
  `counter never moved; got ${boom.stats.unreadable}`);

console.log('\n--- Task 2: tier + dedup ---');
const { norm } = sf;

const recs = [
  { name: 'dup', tier: 2, mtime: 100, path: 'a' },
  { name: 'dup', tier: 1, mtime: 50, path: 'b' },
  { name: 'dup', tier: 2, mtime: 900, path: 'c' },
  { name: 'solo', tier: 2, mtime: 1, path: 'd' },
];
const deduped = sf.dedupe(recs);
check('dedupe collapses duplicate names', deduped.length === 2, `got ${deduped.length}`);
check('dedupe prefers tier 1 over a newer tier 2',
  deduped.find(r => r.name === 'dup').path === 'b',
  `got ${deduped.find(r => r.name === 'dup').path}`);

const olderT2 = sf.dedupe([
  { name: 'x', tier: 2, mtime: 5, path: 'old' },
  { name: 'x', tier: 2, mtime: 9, path: 'new' },
]);
check('within a tier, dedupe keeps the newest mtime', olderT2[0].path === 'new');

const live = sf.livePluginPaths();
check('livePluginPaths finds enabled user-scope plugins', live.length > 0, `got ${live.length}`);

const idx = sf.buildIndex();
const t1 = idx.records.filter(r => r.tier === 1).length;
const t2 = idx.records.filter(r => r.tier === 2).length;
check('real index dedups to roughly 391 skills', Math.abs(idx.records.length - 391) <= 15,
  `got ${idx.records.length}`);
check('real index finds tier-2 skills that no session can see', t2 > 100, `got ${t2}`);
check('tier 1 roughly matches the session listing', Math.abs(t1 - 213) <= 20, `got ${t1}`);
check('a disabled plugin classifies as tier 2',
  idx.records.filter(r => r.tier === 1).every(r => !norm(r.path).includes('/career-ops/')),
  'a career-ops skill was marked loaded, but that plugin is disabled');

console.log('\n--- Task 3: cache ---');
const cacheFile = path.join(__dirname, '..', 'index.json');
fs.rmSync(cacheFile, { force: true });

const t0 = Date.now();
const cold = sf.loadIndex();
const coldMs = Date.now() - t0;
check('cold load writes the cache file', fs.existsSync(cacheFile));

const t1b = Date.now();
const warm = sf.loadIndex();
const warmMs = Date.now() - t1b;
check('warm load returns the same count', warm.records.length === cold.records.length,
  `${warm.records.length} vs ${cold.records.length}`);
check('warm load is much faster than cold', warmMs * 4 < coldMs || warmMs < 100,
  `cold ${coldMs}ms, warm ${warmMs}ms`);

const stale = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
stale.builtAt = Date.now() - 25 * 3600 * 1000;
fs.writeFileSync(cacheFile, JSON.stringify(stale));
check('a >24h cache is rebuilt', sf.loadIndex().builtAt > stale.builtAt);

console.log('\n--- Task 4: scoring ---');
const all = sf.loadIndex().records;

const hit = sf.search('rewrite text into my casual voice', all);
check('finds wes-voice from its own description',
  hit.length && hit[0].record.name === 'wes-voice',
  `got ${hit.length ? hit[0].record.name : 'nothing'}`);

const exact = sf.search('deskclaw', all);
check('an exact name match ranks first',
  exact.length && exact[0].record.name === 'deskclaw',
  `got ${exact.length ? exact[0].record.name : 'nothing'}`);

check('a nonsense query returns nothing', sf.search('zzzqqqxyzzy', all).length === 0);
check('results are capped at 10', sf.search('use when the user', all).length <= 10);
check('stopwords alone return nothing', sf.search('the a of to', all).length === 0);

console.log('\n--- Task 5: CLI ---');
const { spawnSync } = require('child_process');
const script = path.join(__dirname, '..', 'skillfind.cjs');
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const r1 = run('rewrite text into my casual voice');
check('CLI exits 0 on a hit', r1.status === 0, `status ${r1.status}, stderr: ${r1.stderr}`);
check('CLI names the top hit', r1.stdout.includes('wes-voice'), r1.stdout.slice(0, 300));
check('CLI badges tier', /loaded|INVISIBLE/.test(r1.stdout), r1.stdout.slice(0, 300));

const r2 = run('zzzqqqxyzzy');
check('CLI exits 0 on no hits (a miss is information)', r2.status === 0, `status ${r2.status}`);
check('CLI says so plainly on no hits', /no match/i.test(r2.stdout + r2.stderr));

const r3 = run();
check('CLI with no args prints usage and exits 0', r3.status === 0 && /usage/i.test(r3.stdout),
  `status ${r3.status}: ${r3.stdout.slice(0, 200)}`);

console.log('\n--- Task 6: --body tier rule ---');
const idxB = sf.loadIndex().records;
const loadedOne = idxB.find(r => r.tier === 1);
const invisible = idxB.find(r => r.tier === 2);

const bodyLoaded = run(loadedOne.name, '--body');
check('tier-1 --body prints a pointer, never the body',
  /already loaded/i.test(bodyLoaded.stdout) && !/^#\s/m.test(bodyLoaded.stdout),
  bodyLoaded.stdout.slice(0, 300));
check('tier-1 --body names the Skill tool', /Skill tool/.test(bodyLoaded.stdout));

const bodyHidden = run(invisible.name, '--body');
check('tier-2 --body prints the untrusted-source warning',
  /UNTRUSTED/.test(bodyHidden.stdout), bodyHidden.stdout.slice(0, 300));
check('tier-2 --body names the source', bodyHidden.stdout.includes(invisible.source));
check('tier-2 --body prints the real path', bodyHidden.stdout.includes(invisible.path));
check('tier-2 --body actually includes the file body',
  bodyHidden.stdout.includes(fs.readFileSync(invisible.path, 'utf8').trim().slice(-40)),
  'body missing');

console.log('\n--- Task 7: html ---');
const escHtml = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlFile = path.join(__dirname, '..', 'skillfind.html');
fs.rmSync(htmlFile, { force: true });
const rh = run('--html');
check('--html exits 0', rh.status === 0, rh.stderr);
check('--html writes skillfind.html', fs.existsSync(htmlFile));

const html = fs.readFileSync(htmlFile, 'utf8');
const idxAll = sf.loadIndex().records;
const missing = idxAll.filter(r => !html.includes(escHtml(r.name)));
check('html contains every skill', missing.length === 0,
  `missing ${missing.length}, e.g. ${missing.slice(0, 3).map(r => r.name).join(', ')}`);
check('html has a filter box', /<input[^>]+id="q"/.test(html));
check('html badges invisible rows', /INVISIBLE/.test(html));
check('html escapes angle brackets', !/<script>alert/i.test(html));
check('html reports the invisible count',
  html.includes(String(idxAll.filter(r => r.tier === 2).length)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
