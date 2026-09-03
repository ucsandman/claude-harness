#!/usr/bin/env node
// git-tree-guard.cjs - PreToolUse [Bash|PowerShell]
// Blocks git commands that rewrite the shared working tree: stash (push/pop/apply/drop), checkout/restore/switch of
// paths, reset --hard/--merge/--keep, clean, and `git checkout -- .` style discards.
// Incident 2026-09-03 (declick, Show HN prep): a reviewer in a 17-agent fix-findings workflow ran `git stash` to
// prove a test failed without the fix, its `git stash pop` aborted on a conflict because a sibling was editing the
// same file, and the whole first fix pass (25 files) sat reverted in stash@{0} while six other agents kept working
// on the old base. Cost: an hour of reconciliation by three-way merge. Prove a baseline on a COPY (git show HEAD:path
// into the scratchpad, or copy the tree), never by mutating the tree other agents share.
// Override marker for a deliberate, solo-session use: GIT_TREE_OK: <why>.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
// Only a git invocation in command position counts: start of the line or after ; && || | ( or a newline, with
// optional env/sudo prefixes. A "git stash" inside a quoted string (an echo, a commit message, a memory note) is prose.
const AT = '(?:^|[;&|(\\n])\\s*(?:(?:sudo|env|nice|time)\\s+)?(?:\\S+=\\S*\\s+)*';
const STASH = new RegExp(AT + 'git\\s+(?:-C\\s+\\S+\\s+)?stash\\b(?!\\s+(?:list|show)\\b)', 'i');
const DISCARD = new RegExp(AT + 'git\\s+(?:-C\\s+\\S+\\s+)?(?:checkout\\s+(?:--\\s|-f\\b|\\S+\\s+--\\s|\\S+\\s+(?!-b\\b|-B\\b)[^-\\s][^\\s]*\\.(?:mjs|js|ts|tsx|json|md|html|css|py|go|rs|yaml|yml)\\b)|restore\\b(?!.*--staged\\s*$)|reset\\s+(?:--hard|--merge|--keep)\\b|clean\\s+-[a-z]*[fd]|switch\\s+--discard-changes)', 'i');
const OK = /GIT_TREE_OK:/;

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
function logHit(kind, cmd) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'git-tree-guard.log'), new Date().toISOString() + '\t' + kind + '\t' + cmd.replace(/\s+/g, ' ').slice(0, 300) + '\n');
  } catch {}
}

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (!SHELL_TOOLS.has(input.tool_name || '')) process.exit(0);
const cmd = String((input.tool_input || {}).command || '');
if (!cmd.trim()) process.exit(0);
if (OK.test(cmd)) { logHit('override', cmd); process.exit(0); }

if (STASH.test(cmd)) {
  logHit('stash', cmd);
  deny('[git-tree-guard] git stash rewrites the working tree that other agents share. On 2026-09-03 a stash whose pop conflicted left a 25-file fix pass reverted under six concurrent agents. To prove a baseline, work on a copy: `git show HEAD:<path> > <scratchpad>/<name>` and run the test against the copy, or copy the tree to the scratchpad. Solo session and you understand the blast radius: append `# GIT_TREE_OK: <why>`.');
  process.exit(0);
}
if (DISCARD.test(cmd)) {
  logHit('discard', cmd);
  deny('[git-tree-guard] this git command discards or rewrites files in the shared working tree (checkout/restore of paths, reset --hard, clean). Another agent may be mid-edit in those files. Diff against a baseline with `git show <rev>:<path>` into the scratchpad instead. Deliberate solo use: append `# GIT_TREE_OK: <why>`.');
  process.exit(0);
}
process.exit(0);
