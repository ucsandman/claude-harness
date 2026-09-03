#!/usr/bin/env node
/**
 * guard-probe.js — negative-control probe for two harness guards.
 *
 * Per L1: a check never observed failing has been run, not verified.
 * So each guard gets a payload it MUST deny and a payload that is the
 * suspected bypass. Run before and after the fix; the "before" run is
 * supposed to show the bypass passing.
 *
 * The fake credential is assembled at runtime so no key-shaped literal
 * ever sits in this file on disk.
 */
'use strict';

const { spawnSync } = require('child_process');

const HOOKS = 'C:/Users/sandm/.claude/hooks';

// Fake, non-functional. Split so the literal never appears in the file.
const FAKE_KEY = 'sk-ant-' + 'api03-' + 'A'.repeat(95);

// Assembled so this file contains no kill-by-name literal either.
const SP = 'Stop-' + 'Process';
const DIRECT_KILL = `${SP} -Name notepad`;
const INDIRECT_KILL = `$cmd = "${SP}"; & $cmd -Name notepad`;

function run(script, payload) {
  const r = spawnSync('node', [`${HOOKS}/${script}`], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  let decision = 'ALLOW (exit 0, no output)';
  if (out) {
    try {
      const j = JSON.parse(out);
      decision = j.hookSpecificOutput?.permissionDecision?.toUpperCase() || out.slice(0, 60);
    } catch {
      decision = out.slice(0, 60);
    }
  }
  return decision;
}

const CASES = [
  {
    name: 'secret-guard / key via Bash',
    expect: 'DENY',
    got: () => run('secret-guard.cjs', {
      tool_name: 'Bash',
      tool_input: { command: `echo ${FAKE_KEY}` },
    }),
  },
  {
    name: 'secret-guard / key via PowerShell',
    expect: 'DENY',
    got: () => run('secret-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: `Write-Output ${FAKE_KEY}` },
    }),
  },
  {
    name: 'kill-guard / direct name kill',
    expect: 'DENY',
    got: () => run('process-kill-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: DIRECT_KILL },
    }),
  },
  {
    name: 'kill-guard / name kill via variable indirection',
    expect: 'DENY',
    got: () => run('process-kill-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: INDIRECT_KILL },
    }),
  },
  {
    name: 'kill-guard / PID kill must still be ALLOWED',
    expect: 'ALLOW',
    got: () => run('process-kill-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: `${SP} -Id 4242` },
    }),
  },
  {
    name: 'kill-guard / marker override must still be ALLOWED',
    expect: 'ALLOW',
    got: () => run('process-kill-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: `${DIRECT_KILL}  # KILL_BY_NAME_OK` },
    }),
  },
  {
    name: 'secret-guard / clean PowerShell must still be ALLOWED',
    expect: 'ALLOW',
    got: () => run('secret-guard.cjs', {
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-ChildItem C:/Projects' },
    }),
  },
];

let fails = 0;
for (const c of CASES) {
  const got = c.got();
  const pass = got.startsWith(c.expect);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} expect=${c.expect.padEnd(5)} got=${got}`);
}
console.log(`\n${CASES.length - fails} passed / ${fails} failed`);
process.exit(fails ? 1 : 0);
