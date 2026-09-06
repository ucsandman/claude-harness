#!/usr/bin/env node
// gate-freeze-probe.cjs — L1 negative control for hooks/gate-freeze.cjs and the gates.cjs gate-freeze check.
// Every MUST-DENY case is observed denying, every MUST-ALLOW case observed passing; then a guard copy is
// altered on disk and the hash check is observed failing. Run: node ~/.claude/hooks/tests/gate-freeze-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLAUDE = path.resolve(__dirname, '..', '..');
const HOOK = path.join(CLAUDE, 'hooks', 'gate-freeze.cjs');
const GATES = path.join(CLAUDE, 'tools', 'gates', 'gates.cjs');
const PROJECT = 'C:/Projects/some-app';        // outside every harness root
const HARNESS = CLAUDE.replace(/\\/g, '/');
const guard = HARNESS + '/hooks/rm-guard.cjs';

function decide(tool, tool_input, cwd, env = {}) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input, cwd }), encoding: 'utf8', env: { ...process.env, GATE_FREEZE: '', ...env } });
  const out = (r.stdout || '').trim();
  if (!out) return 'ALLOW';
  try { return JSON.parse(out).hookSpecificOutput.permissionDecision.toUpperCase(); } catch { return 'ERR ' + out.slice(0, 60); }
}

const CASES = [
  // [label, tool, input, cwd, want]
  ['Edit a hook from a project session', 'Edit', { file_path: guard, old_string: 'a', new_string: 'b' }, PROJECT, 'DENY'],
  ['Write a hook from a project session', 'Write', { file_path: guard, content: 'x' }, PROJECT, 'DENY'],
  ['Edit the pre-commit chain from a project', 'Edit', { file_path: HARNESS + '/git-hooks/pre-commit', old_string: 'a', new_string: 'b' }, PROJECT, 'DENY'],
  ['Edit the hooks section of settings.json from a project', 'Edit', { file_path: HARNESS + '/settings.json', old_string: '"command": "node x.cjs"', new_string: '' }, PROJECT, 'DENY'],
  ['Edit permissions in settings.json from a project', 'Edit', { file_path: HARNESS + '/settings.json', old_string: '"Bash(npm test)"', new_string: '"Bash(npm test)", "Bash(npm run lint)"' }, PROJECT, 'ALLOW'],
  ['shell redirect onto a hook from a project', 'Bash', { command: 'echo "" > ' + guard }, PROJECT, 'DENY'],
  ['sed -i on a hook from a project', 'Bash', { command: 'sed -i "s/deny/allow/" ' + guard }, PROJECT, 'DENY'],
  ['PowerShell Set-Content on a hook from a project', 'PowerShell', { command: 'Set-Content -Path ' + guard + ' -Value ""' }, PROJECT, 'DENY'],
  ['relock from a project session', 'Bash', { command: 'node ' + HARNESS + '/tools/gates/gates.cjs --lock' }, PROJECT, 'DENY'],
  ['read a hook from a project session', 'Bash', { command: 'cat ' + guard + ' | head -20' }, PROJECT, 'ALLOW'],
  ['run a hook probe from a project session', 'Bash', { command: 'node ' + HARNESS + '/hooks/tests/rm-guard-probe.cjs' }, PROJECT, 'ALLOW'],
  ['Edit a hook from the harness root', 'Edit', { file_path: guard, old_string: 'a', new_string: 'b' }, HARNESS, 'ALLOW'],
  ['Edit a hook from agnostic-ai', 'Edit', { file_path: guard, old_string: 'a', new_string: 'b' }, 'C:/Projects/agnostic-ai/engine', 'ALLOW'],
  ['Edit an unfrozen project file', 'Edit', { file_path: PROJECT + '/src/app.ts', old_string: 'a', new_string: 'b' }, PROJECT, 'ALLOW'],
  ['Edit a hook test file (not frozen)', 'Edit', { file_path: HARNESS + '/hooks/tests/rm-guard-probe.cjs', old_string: 'a', new_string: 'b' }, PROJECT, 'ALLOW'],
  ['shell override marker', 'Bash', { command: 'echo "" > ' + guard + ' # GATE_OK: probe' }, PROJECT, 'ALLOW'],
  ['Read tool is pass-through', 'Read', { file_path: guard }, PROJECT, 'ALLOW'],
];

let fail = 0;
for (const [label, tool, input, cwd, want] of CASES) {
  const got = decide(tool, input, cwd);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  want=${want.padEnd(5)} got=${got.padEnd(5)}  ${label}`);
}
// session off switch
const off = decide('Edit', { file_path: guard, old_string: 'a', new_string: 'b' }, PROJECT, { GATE_FREEZE: 'off' });
if (off !== 'ALLOW') fail++;
console.log(`${off === 'ALLOW' ? 'ok  ' : 'FAIL'}  want=ALLOW got=${off.padEnd(5)}  GATE_FREEZE=off disables for the session`);

// Hash check: with the lock current the check passes; alter a frozen file and it must fail.
const run = () => spawnSync('node', [GATES, 'gate-freeze'], { cwd: CLAUDE, encoding: 'utf8' });
const lockPath = path.join(CLAUDE, 'tools', 'gates', 'gate-manifest.lock.json');
if (!fs.existsSync(lockPath)) { console.log('FAIL  no lock file; run: node tools/gates/gates.cjs --lock'); fail++; }
else {
  const before = run();
  const okBefore = before.status === 0;
  if (!okBefore) fail++;
  console.log(`${okBefore ? 'ok  ' : 'FAIL'}  gate-freeze check passes with the current lock${okBefore ? '' : ':\n' + before.stdout}`);
  const canary = path.join(CLAUDE, 'hooks', 'zz-freeze-canary.cjs');   // matches hooks/*.cjs, so it is frozen but unlocked
  fs.writeFileSync(canary, '// freeze canary\n');
  try {
    const during = run();
    const okDuring = during.status !== 0 && /ADDED .*zz-freeze-canary/.test(during.stdout);
    if (!okDuring) fail++;
    console.log(`${okDuring ? 'ok  ' : 'FAIL'}  gate-freeze check FAILS when an unlocked guard file appears`);
  } finally { fs.unlinkSync(canary); }
}

const total = CASES.length + 3;
console.log(`\ngate-freeze-probe: ${total - fail}/${total} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
