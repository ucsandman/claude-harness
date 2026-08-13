#!/usr/bin/env node
/**
 * dev-server-guard.cjs — prevents the 2026-07-30 incident class:
 * a dev server left running as a background task leaked ~663 tsserver
 * children (~13.6 GB) after TaskStop killed only the npm wrapper shim.
 *
 * PreToolUse (Bash|PowerShell):
 *   - DENY dev-server commands piped through head/tail (detaches output
 *     without stopping the server — never correct).
 *   - DENY dev-server commands with run_in_background:true UNLESS the
 *     command carries the explicit marker DEV_SERVER_BG_OK (a deliberate
 *     opt-in; the deny message explains the teardown contract).
 * PostToolUse (TaskStop):
 *   - Inject a reminder that on Windows TaskStop kills the wrapper only;
 *     the node tree must be verified dead (port check + taskkill /F /T).
 */
'use strict';

const DEV_SERVER_RE =
  /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:dev|start)\b|\bnext\s+dev\b|\bvite\b(?!st)|\bnuxt\s+dev\b|\bastro\s+dev\b|\bwebpack(?:-dev-server|\s+serve)\b|\bnodemon\b|\blaunch\.py\b/i;
const PIPE_TRUNC_RE = /\|\s*(?:head|tail)\b/;
const MARKER = 'DEV_SERVER_BG_OK';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // unparseable input: never block on our own bug
  }

  const tool = input.tool_name || '';
  const ti = input.tool_input || {};

  if (tool === 'TaskStop') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            'dev-server-guard: On Windows, TaskStop kills only the wrapper shim (npm.cmd/rtk); ' +
            'child node processes survive. If this task ran a server, verify the tree is dead: ' +
            'find the PID listening on its port (Get-NetTCPConnection -LocalPort <port>), ' +
            'taskkill /F /T /PID it, then confirm the port is free.',
        },
      }),
    );
    process.exit(0);
  }

  if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);
  const cmd = String(ti.command || '');
  if (!DEV_SERVER_RE.test(cmd)) process.exit(0);

  if (PIPE_TRUNC_RE.test(cmd)) {
    deny(
      'dev-server-guard: piping a dev server through head/tail detaches its output without ' +
        'stopping it (this orphaned a server on 2026-07-30 and nearly exhausted RAM). ' +
        'Run it without the pipe and read the task output file instead.',
    );
    process.exit(0);
  }

  if (ti.run_in_background === true && !cmd.includes(MARKER)) {
    deny(
      'dev-server-guard: backgrounding a dev server without a teardown contract is blocked ' +
        '(a background-and-forget dev server leaked 663 tsserver children on 2026-07-30). ' +
        'Prefer a foreground run with a timeout for quick checks. If a live server is truly ' +
        'required, re-run with the marker comment  # ' + MARKER + '  appended to the command, ' +
        'and you MUST tear it down immediately after verification: find the PID listening on ' +
        'the port, taskkill /F /T /PID it, and confirm the port is free before moving on.',
    );
    process.exit(0);
  }

  process.exit(0);
})();
