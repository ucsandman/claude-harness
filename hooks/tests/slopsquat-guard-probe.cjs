#!/usr/bin/env node
// slopsquat-guard-probe.cjs — L1 negative control for hooks/slopsquat-guard.cjs. The parser cases run offline;
// the verdict cases hit the real registries (npm, PyPI, crates.io), so a network failure shows as UNVERIFIED denies
// on the ALLOW rows, which is the fail-closed path working, not the parser breaking.
// Run: node ~/.claude/hooks/tests/slopsquat-guard-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const HOOK = path.join(__dirname, '..', 'slopsquat-guard.cjs');
const { packagesIn } = require(HOOK);

let fail = 0;
const show = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

// 1. parser: which names get looked up
const PARSE = [
  ['npm i zod', ['npm:zod']],
  ['npm install --save-dev @types/node typescript@5', ['npm:@types/node', 'npm:typescript']],
  ['pnpm add -D vitest', ['npm:vitest']],
  ['yarn add react react-dom', ['npm:react', 'npm:react-dom']],
  ['bun add hono', ['npm:hono']],
  ['npx create-next-app@latest my-app --ts', ['npm:create-next-app']],   // args after the runner target are the app's
  ['npm install', []],                                                     // lockfile install
  ['npm i ./local-pkg', []],
  ['npm i git+https://github.com/x/y.git', []],
  ['pip install requests', ['pypi:requests']],
  ['pip install -r requirements.txt', []],
  ['pip install -e .', []],
  ['pip install "fastapi[standard]>=0.100" Pillow', ['pypi:fastapi', 'pypi:pillow']],
  ['python -m pip install httpx', ['pypi:httpx']],
  ['uv add ruff', ['pypi:ruff']],
  ['uv pip install pytest', ['pypi:pytest']],
  ['cargo add serde --features derive', ['crates:serde']],
  ['cargo install ripgrep', ['crates:ripgrep']],
  ['cd app && npm i zod; git status', ['npm:zod']],
  ['echo "npm i zod"', []],                                                // prose, echo is the command
  ['npm run build', []],
  ['npm test', []],
];
for (const [cmd, want] of PARSE) {
  const got = [].concat(...cmd.split(/\s*(?:;|&&|\|\||\|)\s*/).map((s) => packagesIn(s))).map((p) => `${p.registry}:${p.name}`);
  show(JSON.stringify(got) === JSON.stringify(want), `parse  ${cmd.padEnd(58)} → ${got.join(' ') || '(none)'}`);
}

// 2. verdicts against the live registries
function decide(command, env = {}) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, SLOPSQUAT_GUARD: '', ...env } });
  const out = (r.stdout || '').trim();
  if (!out) return 'ALLOW';
  try { const j = JSON.parse(out).hookSpecificOutput; return 'DENY ' + (j.permissionDecisionReason.match(/\n\s+([A-Z ]+?)\s{2,}/) || [, '?'])[1].trim(); } catch { return 'ERR ' + out.slice(0, 60); }
}
const LIVE = [
  ['npm i zod', 'ALLOW'],
  ['npm i zod-utils-helper-typo-xq9z7', 'DENY NOT FOUND'],
  ['npm i left-pad', 'DENY STALE'],                       // last publish 2018
  ['npm i left-pad # PKG_OK: probe, known stable', 'ALLOW'],
  ['pip install requests', 'ALLOW'],
  ['pip install reqeusts-typo-xq9z7', 'DENY NOT FOUND'],
  ['cargo add serde', 'ALLOW'],
  ['cargo add serde-typo-xq9z7-nope', 'DENY NOT FOUND'],
  ['npm i zod && pip install reqeusts-typo-xq9z7', 'DENY NOT FOUND'],   // one bad name in a chain denies the chain
];
for (const [cmd, want] of LIVE) {
  const got = decide(cmd);
  show(got === want, `live   want=${want.padEnd(15)} got=${got.padEnd(15)}  ${cmd}`);
}
const off = decide('npm i zod-utils-helper-typo-xq9z7', { SLOPSQUAT_GUARD: 'off' });
show(off === 'ALLOW', `live   want=ALLOW           got=${off.padEnd(15)}  SLOPSQUAT_GUARD=off`);
const readTool = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Read', tool_input: { command: 'npm i nope-xq9z7' } }), encoding: 'utf8' });
show(!(readTool.stdout || '').trim(), 'non-shell tool is pass-through');

const total = PARSE.length + LIVE.length + 2;
console.log(`\nslopsquat-guard-probe: ${total - fail}/${total} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
