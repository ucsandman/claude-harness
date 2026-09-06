#!/usr/bin/env node
// wiredark-probe.cjs — L1 negative control for tools/wiredark/wiredark.cjs. Builds a scratch git repo, stages
// each shape, and checks the verdict in BOTH directions: a dark export must BLOCK, every legitimate shape must pass.
// Run: node ~/.claude/hooks/tests/wiredark-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'wiredark', 'wiredark.cjs');
const ROOT = fs.mkdtempSync(path.join(process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), 'wiredark-probe-'));
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'probe@local'); git('config', 'user.name', 'probe');
const write = (rel, text) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// Baseline commit so "new" means added by the staged change.
write('src/old.ts', 'export function old() { return 1; }\n');
write('README.md', 'probe\n');
// --no-verify: the global pre-commit now runs wiredark itself and would block this base commit (old() has no caller).
git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'base');

const CASES = [
  // [label, files to write, want exit, want verdict for the named symbol]
  ['dark fn with only a test caller', { 'src/a.ts': 'export function foo() { return 1; }\n', 'tests/a.test.ts': "import { foo } from '../src/a';\ntest('x', () => foo());\n" }, 1, ['foo', 'DARK']],
  ['wired by a production import', { 'src/a.ts': 'export function foo() { return 1; }\n', 'src/b.ts': "import { foo } from './a';\nconsole.log(foo());\n" }, 0, ['foo', 'WIRED']],
  ['registered dark via marker', { 'src/c.ts': '// WIRE-DARK[probe: consumer lands in step 2]\nexport function bar() { return 2; }\n' }, 0, ['bar', 'REGISTERED-DARK']],
  ['barrel re-export only', { 'src/d.ts': 'export function baz() { return 3; }\n', 'src/index.ts': "export { baz } from './d';\n" }, 0, ['baz', 'REEXPORTED']],
  ['same-file helper', { 'src/e.ts': 'export function helper() { return 4; }\nconsole.log(helper());\n' }, 0, ['helper', 'INTERNAL']],
  ['framework route handler is skipped', { 'app/api/x/route.ts': 'export async function GET() { return new Response("ok"); }\n' }, 0, ['GET', null]],
  ['dark type is a warn', { 'src/t.ts': 'export interface Opts { a: number }\n' }, 0, ['Opts', 'DARK-TYPE']],
  ['export inside a test file is skipped', { 'tests/util.ts': 'export function mk() { return 1; }\n' }, 0, ['mk', null]],
  ['python top-level def with no caller', { 'pkg/m.py': 'def run():\n    return 1\n' }, 1, ['run', 'DARK']],
  ['python def called from cli', { 'pkg/m.py': 'def run():\n    return 1\n', 'pkg/cli.py': 'from pkg.m import run\nrun()\n' }, 0, ['run', 'WIRED']],
  ['python private def is skipped', { 'pkg/p.py': 'def _hidden():\n    return 1\n' }, 0, ['_hidden', null]],
  ['commonjs exports.name with no caller', { 'lib/x.cjs': 'exports.thing = function () { return 1; };\n' }, 1, ['thing', 'DARK']],
  ['edit to an existing export is not new', { 'src/old.ts': 'export function old() { return 2; }\n' }, 0, ['old', null]],
];

let fail = 0;
for (const [label, files, wantExit, [sym, wantVerdict]] of CASES) {
  git('reset', '-q', '--hard'); git('clean', '-fdq');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  git('add', '-A');
  const r = spawnSync('node', [TOOL, '--json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WIREDARK: '' } });
  let got = null; let verdict = null;
  try { got = JSON.parse(r.stdout); verdict = (got.findings.find((f) => f.name === sym) || {}).verdict || null; } catch { verdict = 'ERR ' + (r.stderr || r.stdout).slice(0, 80); }
  const ok = r.status === wantExit && verdict === wantVerdict;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  exit want=${wantExit} got=${r.status}  ${sym}: want=${String(wantVerdict).padEnd(15)} got=${String(verdict).padEnd(15)}  ${label}`);
}

// Fail-closed: outside a git repo the scan must exit 2, never 0.
const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wiredark-norepo-'));
const r2 = spawnSync('node', [TOOL], { cwd: noRepo, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(noRepo) } });
const ok2 = r2.status === 2;
if (!ok2) fail++;
console.log(`${ok2 ? 'ok  ' : 'FAIL'}  exit want=2 got=${r2.status}  scan outside a repo fails closed`);

fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(noRepo, { recursive: true, force: true });
console.log(`\nwiredark-probe: ${CASES.length + 1 - fail}/${CASES.length + 1} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
