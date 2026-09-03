#!/usr/bin/env node
// slow-command-guard.cjs - PreToolUse [Bash|PowerShell]
// Two rules for commands that hang a session:
//  1. run_in_background on a finite test/build (port of bg-test-guard.ps1, 2026-08-11:
//     a backgrounded vitest run burned 300k tokens on a Monitor that never resolved).
//     Override marker: BG_TEST_OK.
//  2. Recursive grep/rg/find rooted at C:\Projects, the home dir, or a drive root.
//     Profiled 2026-09-01: five such calls at 120-180s each in 8 sessions. Scope to
//     one repo, add --glob, or use the Grep tool. Override marker: SLOW_OK.
// Long-lived watchers (dev/serve/watch/start) are dev-server-guard's territory.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
const FINITE = /\b(vitest|jest|pytest|playwright\s+test|cargo\s+test|go\s+test|tsc\b|next\s+build|npm\s+run\s+build|npm\s+test\b|npm\s+run\s+test\S*|npx\s+(vitest|jest|playwright))/i;
const WATCHER = /\b(dev\b|watch|serve\b|start\b|--watch)/i;
// A recursive search tool...
const RECURSIVE = /(\b(grep|egrep|fgrep)\b[^|;&\n]*\s(-[A-Za-z]*[rR][A-Za-z]*\b|--recursive|--dereference-recursive)|\brg\b|\bfind\b|Get-ChildItem\b[^|;&\n]*-Recurse|\bgci\b[^|;&\n]*-Recurse)/;
// ...whose path argument IS a root (nothing deeper than Projects, home, or a drive).
const ROOT = /(^|[\s"'=])(\/c\/Projects|[A-Za-z]:[\\/]Projects|~|\$HOME|\$env:USERPROFILE|\/c\/Users\/[^\s\\/"']+|[A-Za-z]:[\\/]Users[\\/][^\s\\/"']+|[A-Za-z]:|\/c)[\\/]?(?=[\s"']|$)/m;

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
function logHit(kind, cmd) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'slow-command-guard.log'), new Date().toISOString() + '\t' + kind + '\t' + cmd.replace(/\s+/g, ' ').slice(0, 300) + '\n');
  } catch {}
}

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (!SHELL_TOOLS.has(input.tool_name || '')) process.exit(0);
const ti = input.tool_input || {};
const cmd = String(ti.command || '');
if (!cmd.trim()) process.exit(0);

if (ti.run_in_background === true && !/BG_TEST_OK/.test(cmd) && FINITE.test(cmd) && !WATCHER.test(cmd)) {
  logHit('bg-test', cmd);
  deny('slow-command-guard: finite test/build commands run FOREGROUND with an explicit timeout (a backgrounded test run burned 300k tokens waiting on a Monitor that never resolved). Re-run without run_in_background and set a timeout. Override marker if genuinely needed: BG_TEST_OK.');
  process.exit(0);
}

if (!/SLOW_OK/.test(cmd) && RECURSIVE.test(cmd) && ROOT.test(cmd)) {
  logHit('root-grep', cmd);
  deny('slow-command-guard: recursive search rooted at C:\\Projects, the home dir, or a drive takes 120-180s on this machine (five of them ate an hour across 8 profiled sessions). Scope it to one repo path, add --glob/--include, or use the Grep tool with a path. Override marker if the whole tree is really the target: SLOW_OK.');
  process.exit(0);
}
process.exit(0);
