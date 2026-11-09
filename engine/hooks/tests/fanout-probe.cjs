'use strict';
const { spawnSync } = require('child_process');
const HOOK = require('path').join(__dirname, '..', 'agent-model-guard.cjs');
const F = "'fable'";

function run(script) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Workflow', tool_input: { script } }),
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  if (!out) return 'ALLOW';
  try { return JSON.parse(out).hookSpecificOutput.permissionDecision.toUpperCase(); }
  catch { return out.slice(0, 50); }
}

const CASES = [
  ['direct fable in a for-loop', 'DENY',
   `for (let i=0;i<50;i++) { await agent('x', {model:${F}}) }`],
  ['fable via helper declared OUTSIDE the loop', 'DENY',
   `const spawn = () => agent('x', {model:${F}});\nfor (let i=0;i<50;i++) { await spawn() }`],
  ['fable via helper + .map', 'DENY',
   `const spawn = () => agent('x', {model:${F}});\nawait parallel(items.map(() => spawn()))`],
  ['single fable call, NO fan-out anywhere, must ALLOW', 'ALLOW',
   `const r = await agent('architecture call', {model:${F}});`],
  ['sonnet fan-out with a declared MAX_AGENTS, must ALLOW', 'ALLOW',
   `// MAX_AGENTS: 12
await parallel(items.map(i => () => agent('x', {model:'claude-sonnet-5'})))`],
  ['MAX_AGENTS as a const, prose comment (2026-11-08: a backspace byte in the regex denied every saved tournament)', 'ALLOW',
   `// MAX_AGENTS: lenses + judges + 1; hard ceiling enforced below
const MAX_AGENTS = 30
await parallel(items.map(i => () => agent('x', {model:'opus'})))`],
  ['sonnet fan-out with NO MAX_AGENTS declaration (2026-09-19: 225 queued)', 'DENY',
   `await parallel(items.map(i => () => agent('x', {model:'claude-sonnet-5'})))`],
  ['MAX_AGENTS above 40 without FANOUT_OK', 'DENY',
   `// MAX_AGENTS: 120
await parallel(items.map(i => () => agent('x', {model:'sonnet'})))`],
  ['MAX_AGENTS above 40 with FANOUT_OK', 'ALLOW',
   `// MAX_AGENTS: 120
// FANOUT_OK: user asked for every file
await parallel(items.map(i => () => agent('x', {model:'sonnet'})))`],
  ['single agent, no fan-out, no declaration, must ALLOW', 'ALLOW',
   `const r = await agent('x', {model:'opus'});`],
];

let fails = 0;
for (const [name, expect, script] of CASES) {
  const got = run(script);
  const pass = got === expect;
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} expect=${expect.padEnd(5)} got=${got}`);
}
console.log(`\n${CASES.length - fails} passed / ${fails} failed`);
process.exit(fails ? 1 : 0);
