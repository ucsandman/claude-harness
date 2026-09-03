#!/usr/bin/env node
// rm-guard-probe.cjs — L1 negative control for rm-guard.cjs: every MUST-DENY case is observed failing, every
// MUST-ALLOW case observed passing. Run: node ~/.claude/hooks/tests/rm-guard-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const HOOK = 'C:/Users/sandm/.claude/hooks/rm-guard.cjs';

function decide(tool, command) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command } }), encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (!out) return 'ALLOW';
  try { return JSON.parse(out).hookSpecificOutput.permissionDecision.toUpperCase(); } catch { return 'ERR ' + out.slice(0, 60); }
}

const CASES = [
  // [tool, command, expected]
  ['Bash', 'rm -rf C:/Projects/foo', 'DENY'],
  ['Bash', 'cd build; rm -rf .', 'DENY'],                     // chained: the permission list misses this
  ['Bash', 'git status && rm -r ~/.claude/skills', 'DENY'],
  ['Bash', 'rm -rf dist/../src', 'DENY'],                     // dot-dot escapes a safe dir
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\Projects\\foo', 'DENY'],
  ['PowerShell', 'Get-ChildItem C:\\x | Remove-Item -Recurse', 'DENY'],   // no literal target
  ['PowerShell', 'rmdir /s /q C:\\Projects\\foo', 'DENY'],
  ['PowerShell', 'Remove-Item -Path src -Recurse', 'DENY'],
  ['Bash', 'rm -rf node_modules dist', 'ALLOW'],
  ['Bash', 'rm -rf ./build/', 'ALLOW'],
  ['Bash', 'rm -f package-lock.json', 'ALLOW'],               // not recursive
  ['Bash', 'rm -rf C:/Users/sandm/AppData/Local/Temp/claude/x/scratchpad/out', 'ALLOW'],
  ['PowerShell', 'Remove-Item -Recurse -Force node_modules', 'ALLOW'],
  ['PowerShell', 'Remove-Item foo.txt', 'ALLOW'],
  ['Bash', 'echo "never run rm -rf /"', 'ALLOW'],            // prose, not command position
  ['Bash', 'rm -rf C:/Projects/foo # RM_OK: Wes confirmed 2026-09-03', 'ALLOW'],
  ['Read', 'rm -rf C:/Projects/foo', 'ALLOW'],                // wrong tool: pass-through
];

let fail = 0;
for (const [tool, cmd, want] of CASES) {
  const got = decide(tool, cmd);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  want=${want.padEnd(5)} got=${got.padEnd(5)}  ${tool.padEnd(10)} ${cmd}`);
}
console.log(`\nrm-guard-probe: ${CASES.length - fail}/${CASES.length} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
