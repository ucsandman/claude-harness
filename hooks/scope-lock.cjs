#!/usr/bin/env node
/**
 * scope-lock.cjs — per-session working-scope enforcement.
 *
 * Why: with multiple Claude Code agents in one repo, the most-retyped manual
 * instruction was "don't edit anything outside <dir>". This makes the harness
 * enforce it instead of relying on the model remembering.
 *
 * Usage (typed as a normal prompt, handled here before the model acts):
 *   scope-lock <path>   -> restrict Edit/Write/NotebookEdit to <path> (resolved vs cwd)
 *   scope-unlock        -> lift the restriction
 *
 * Wired as: UserPromptSubmit (create/remove locks) and PreToolUse on
 * Edit|Write|NotebookEdit (enforce). Bash/PowerShell are NOT intercepted —
 * shell commands are too ambiguous to parse safely; the lock is a guardrail
 * for file-editing tools, not a sandbox.
 *
 * Fail-safe: any unexpected error exits 0 (never blocks legitimate work).
 * Limitations: symlinks/8.3 short names are not resolved (guardrail, not a
 * sandbox). Subagent tool calls fire PreToolUse in the parent session, so the
 * lock is expected to cover them too — if a subagent ever bypasses it, check
 * whether the hook payload's session_id matched the lock file name.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCK_DIR = path.join(os.homedir(), '.claude', 'scope-locks');
const MAX_LOCK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // stale-lock cleanup

function norm(p) {
  let r = path.resolve(p);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

function isInside(child, root) {
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function lockPath(sessionId) {
  return path.join(LOCK_DIR, `${sessionId}.json`);
}

function cleanupStale() {
  try {
    for (const f of fs.readdirSync(LOCK_DIR)) {
      const fp = path.join(LOCK_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_LOCK_AGE_MS) fs.unlinkSync(fp);
    }
  } catch {}
}

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const sessionId = data.session_id;
  if (!sessionId) return;

  if (data.hook_event_name === 'UserPromptSubmit') {
    const prompt = String(data.prompt || '').trim();
    const lockMatch = prompt.match(/^scope-lock\s+(.+)$/i);
    if (lockMatch) {
      const root = path.resolve(data.cwd || process.cwd(), lockMatch[1].trim().replace(/^["']|["']$/g, ''));
      if (!fs.existsSync(root)) {
        console.log(`[scope-lock] NOT created: ${root} does not exist. Use "scope-lock <existing dir>" with nothing after the path (quotes are fine for paths with spaces).`);
        return;
      }
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      fs.writeFileSync(lockPath(sessionId), JSON.stringify({ root, cwd: data.cwd, created: new Date().toISOString() }));
      cleanupStale();
      console.log(`[scope-lock] ACTIVE: this session's Edit/Write tools are now restricted to ${root}. The harness will block edits outside it. Acknowledge the lock to the user in one line and do not attempt edits outside the scope. (User can lift it by typing "scope-unlock".)`);
      return;
    }
    if (/^scope-unlock$/i.test(prompt)) {
      try { fs.unlinkSync(lockPath(sessionId)); } catch {}
      console.log('[scope-lock] Lock removed: edits are no longer restricted for this session.');
      return;
    }
    return;
  }

  if (data.hook_event_name === 'PreToolUse') {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath(sessionId), 'utf8'));
    } catch {
      return; // no lock for this session
    }
    const ti = data.tool_input || {};
    let target = ti.file_path || ti.notebook_path;
    if (!target) return;
    target = path.resolve(data.cwd || lock.cwd || process.cwd(), target); // relative paths resolve vs the session cwd, not the hook's
    if (isInside(target, lock.root)) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `scope-lock: this session is restricted to ${lock.root}; refusing to edit ${target}. Work within the scope, or ask the user to type "scope-unlock".`,
      },
    }));
  }
}

try {
  main();
} catch {}
process.exit(0);
