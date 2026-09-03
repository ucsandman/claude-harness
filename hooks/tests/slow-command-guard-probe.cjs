#!/usr/bin/env node
// Self-check for slow-command-guard.cjs: proves it both denies and allows (L1).
// Run: node ~/.claude/hooks/tests/slow-command-guard-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const G = path.join(__dirname, '..', 'slow-command-guard.cjs');
const cases = [
  ['bg finite test', 'deny', { tool_name: 'Bash', tool_input: { command: 'npx vitest run', run_in_background: true } }],
  ['bg watcher', 'allow', { tool_name: 'Bash', tool_input: { command: 'npm run ' + 'dev', run_in_background: true } }],
  ['bg marker', 'allow', { tool_name: 'Bash', tool_input: { command: 'npx vitest run # BG_TEST_OK', run_in_background: true } }],
  ['fg finite test', 'allow', { tool_name: 'Bash', tool_input: { command: 'npx vitest run' } }],
  ['grep -rl at Projects root via cd .', 'deny', { tool_name: 'Bash', tool_input: { command: 'cd /c/Projects && grep -rl -E "foo" --include=*.md .' } }],
  ['grep -rl quoted Projects', 'deny', { tool_name: 'Bash', tool_input: { command: 'grep -rl -i revefi "/c/Projects" --include=*.csv' } }],
  ['grep -r home', 'deny', { tool_name: 'Bash', tool_input: { command: 'grep -r TODO ~' } }],
  ['rg Projects', 'deny', { tool_name: 'Bash', tool_input: { command: 'rg -n secret C:/Projects' } }],
  ['find Projects', 'deny', { tool_name: 'Bash', tool_input: { command: 'find /c/Projects -name node_modules' } }],
  ['gci -Recurse Projects', 'deny', { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem C:\\Projects -Recurse -Filter *.env' } }],
  ['grep -rn one repo', 'allow', { tool_name: 'Bash', tool_input: { command: 'grep -rn foo /c/Projects/solver/web' } }],
  ['rg one repo', 'allow', { tool_name: 'Bash', tool_input: { command: 'rg -n foo C:/Projects/DashClaw --glob *.ts' } }],
  ['grep non-recursive', 'allow', { tool_name: 'Bash', tool_input: { command: 'grep -n foo /c/Projects/x.txt' } }],
  ['grep root with SLOW_OK', 'allow', { tool_name: 'Bash', tool_input: { command: 'grep -rl foo /c/Projects # SLOW_OK' } }],
  ['cd into repo then grep -r .', 'allow', { tool_name: 'Bash', tool_input: { command: 'cd /c/Projects/solver && grep -rn foo .' } }],
  ['garbage', 'allow', 'not json'],
];
let fail = 0;
for (const [label, want, payload] of cases) {
  const r = spawnSync('node', [G], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
  const got = /"deny"/.test(r.stdout) ? 'deny' : 'allow';
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' -> ' + got + (ok ? '' : ' (want ' + want + ')'));
}
console.log((fail ? 'FAILED ' + fail : 'all passed') + ' of ' + cases.length + ' cases');
process.exit(fail ? 1 : 0);
