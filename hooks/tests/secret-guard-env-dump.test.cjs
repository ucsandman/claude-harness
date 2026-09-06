#!/usr/bin/env node
'use strict';
// Regression cases for secret-guard's environment-dump denial (2026-09-06).
// Run: node hooks/tests/secret-guard-env-dump.test.cjs   (exit 1 on any miss)
//
// Lives in a file, not a shell one-liner, because a command line that merely
// CONTAINS `$(env)` as a test string is itself denied by the guard — which is
// the right call (the guard cannot know your quoting), and a nice live proof.
const path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'secret-guard.cjs');

const DENY = 'DENY';
const ALLOW = 'ALLOW';
const cases = [
  // --- dumps: denied -----------------------------------------------------
  ['env | grep -i "^CLAUDE\\|^ANTHROPIC"', DENY, 'the command that leaked a key'],
  ['env', DENY, 'bare env'],
  ['printenv', DENY, 'bare printenv'],
  ['export -p', DENY, 'export -p'],
  ['declare -x', DENY, 'declare -x'],
  ['cat /proc/self/environ', DENY, 'proc environ'],
  ['env > out.txt', DENY, 'redirect to a file'],
  ['printenv >> log', DENY, 'append redirect'],
  ['echo $(env)', DENY, 'command substitution'],
  ['echo `env`', DENY, 'backtick substitution'],
  ['sudo env', DENY, 'sudo wrapper'],
  ['npm test && env', DENY, 'after &&'],
  ['echo hi\nenv', DENY, 'multi-line, env on its own line'],
  ['set', DENY, 'bare set'],
  ['env | tee x.txt | wc -l', DENY, 'tee defeats the count sink'],
  ['env | grep -c X > n.txt', DENY, 'redirect after a count sink'],
  ['Get-ChildItem Env:', DENY, 'PowerShell env: drive'],
  ['gci env: | Format-Table', DENY, 'gci env: piped'],
  ['ls env:*', DENY, 'ls env:*'],
  ['dir env:', DENY, 'dir env:'],
  ['[Environment]::GetEnvironmentVariables()', DENY, '.NET dump'],
  ['python -c "import os; print(os.environ)"', DENY, 'os.environ printed'],
  ['python -c "import os; print(dict(os.environ))"', DENY, 'dict(os.environ)'],
  ['node -e "console.log(process.env)"', DENY, 'process.env printed'],
  ['node -e "console.log({...process.env})"', DENY, 'process.env spread'],
  // --- named reads and look-alikes: allowed --------------------------------
  ['printenv PATH', ALLOW, 'one named var'],
  ['env FOO=bar node x.js', ALLOW, 'env as a prefix'],
  ['/usr/bin/env node script.js', ALLOW, 'interpreter lookup'],
  ['echo $HOME', ALLOW, 'named expansion'],
  ['echo $env:PATH', ALLOW, 'PowerShell named var'],
  ['gci env:PATH', ALLOW, 'PowerShell drive, one var'],
  ['env | grep -c ANTHROPIC', ALLOW, 'count only'],
  ['env | grep --count X', ALLOW, '--count'],
  ['env | wc -l', ALLOW, 'tally only'],
  ['set -e', ALLOW, 'set -e'],
  ['set -o pipefail; npm test', ALLOW, 'set -o pipefail'],
  ['echo env', ALLOW, 'env as a word'],
  ['grep env file.txt', ALLOW, 'env as a grep pattern'],
  ['ls environments/', ALLOW, 'env-prefixed directory'],
  ['git status', ALLOW, 'unrelated'],
  ['python -c "import os; print(os.environ.get(\'X\'))"', ALLOW, 'os.environ.get'],
  ['python -c "import os; print(os.environ[\'X\'])"', ALLOW, 'os.environ[X]'],
  ['node -e "console.log(process.env.HOME)"', ALLOW, 'process.env.HOME'],
  ['node -e "console.log(process.env[\'HOME\'])"', ALLOW, 'process.env[HOME]'],
  ['export FOO=bar', ALLOW, 'export with an assignment'],
  ['declare -x FOO=bar', ALLOW, 'declare -x with an assignment'],
];

let failures = 0;
for (const [cmd, want, why] of cases) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
  let out = '';
  try {
    out = execFileSync('node', [GUARD], { input: payload, encoding: 'utf8' });
  } catch (e) {
    out = 'THREW ' + e.message;
  }
  const got = out.includes('"deny"') ? DENY : out.startsWith('THREW') ? 'THREW' : ALLOW;
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${got.padEnd(5)} (want ${want.padEnd(5)})  ${why}   << ${JSON.stringify(cmd)}`);
}
console.log(`\n${cases.length} cases, ${failures} failures`);
process.exit(failures ? 1 : 0);
