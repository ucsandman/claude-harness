'use strict';
const { spawnSync } = require('child_process');
const HOOK = 'C:/Users/sandm/.claude/hooks/agent-model-guard.cjs';
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
  ['sonnet fan-out with no fable, must ALLOW', 'ALLOW',
   `await parallel(items.map(i => () => agent('x', {model:'claude-sonnet-5'})))`],
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
