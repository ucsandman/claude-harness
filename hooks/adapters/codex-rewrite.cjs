#!/usr/bin/env node
'use strict';
/*
 * codex-rewrite.cjs — PreToolUse (Bash) adapter that gives Codex the same
 * command rewriting Claude Code gets from two hooks: `rtk hook claude`
 * (output compression) and `repowise-rewrite` (distilled git/test output).
 *
 * Why an adapter and not the two commands directly (2026-09-05):
 *   - rtk emits hookSpecificOutput.updatedInput with NO permissionDecision;
 *     Codex only applies updatedInput alongside permissionDecision "allow" and
 *     reports any other shape as a hook error.
 *   - repowise emits permissionDecision "ask", which Codex does not support:
 *     it marks the hook failed and runs the ORIGINAL command.
 *   - Codex launches matching hooks concurrently, so two rewriters racing for
 *     the same command is undefined; one adapter applies them in order.
 *
 * Order: rtk first (proven on this machine, has the vitest/jest exclusions in
 * ~/AppData/Roaming/rtk/config.toml), then repowise on whatever rtk produced.
 * The first rewriter that changes the command wins. Fail-open: any error means
 * no output, exit 0, original command runs.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// repowise is OFF for Codex (2026-09-05): `repowise` is a Microsoft-Store Python
// script and does not launch inside Codex's sandboxed pwsh (exit 1, empty output,
// 11 ms). Every `npm test` in 9 of 9 sessions that day was rewritten into that
// failure, and the model paid a full ~35k-token turn to notice and retry. rtk is a
// native exe in ~/bin and works. Re-enable only after a sandboxed `repowise
// distill` is seen succeeding in a rollout.
const REWRITERS = [
  { name: 'rtk', cmd: 'rtk', args: ['hook', 'claude'] },
];

function run(rw, payload) {
  const cwd = path.resolve(payload.cwd || process.cwd()).toLowerCase();
  const executable = (process.env.PATH || '').split(path.delimiter)
    .filter(dir => path.isAbsolute(dir) && !path.resolve(dir).toLowerCase().startsWith(cwd + path.sep) && path.resolve(dir).toLowerCase() !== cwd)
    .map(dir => path.join(dir, rw.cmd + (process.platform === 'win32' ? '.exe' : '')))
    .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!executable) return null;
  const r = spawnSync(executable, rw.args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    shell: false,
    timeout: 4000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  try {
    const out = JSON.parse(r.stdout.trim());
    const spec = out && out.hookSpecificOutput;
    const next = spec && spec.updatedInput && spec.updatedInput.command;
    if (typeof next !== 'string' || !next || next === payload.tool_input.command) return null;
    return { command: next, reason: spec.permissionDecisionReason || `${rw.name} rewrite` };
  } catch {
    return null;
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  if (!payload.tool_input || typeof payload.tool_input.command !== 'string') return;
  if (process.env.CODEX_REWRITE_OFF === '1') return;

  for (const rw of REWRITERS) {
    const hit = run(rw, payload);
    if (!hit) continue;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: hit.reason,
          updatedInput: { command: hit.command },
        },
      })
    );
    return;
  }
}

try {
  main();
} catch {
  /* fail open */
}
process.exit(0);
