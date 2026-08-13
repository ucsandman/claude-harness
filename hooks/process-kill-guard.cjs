#!/usr/bin/env node
/**
 * process-kill-guard.cjs — prevents the 2026-08-12 incident class:
 * a subagent cleaning up its own test window ran `Stop-Process -Name notepad`,
 * which matches by IMAGE NAME and killed Wes's real Notepad session
 * (~40 tabs, several unsaved). The agent followed its instructions; the
 * instruction never said "by PID", and nothing in the harness enforced it.
 *
 * Rule: a process you did not create is not yours to kill. Name-based kills
 * cannot tell your process from the user's. PID-based kills can.
 *
 * PreToolUse (Bash|PowerShell):
 *   - DENY name/image/pattern-based process termination
 *     (Stop-Process -Name, Get-Process <name> | Stop-Process, taskkill /IM,
 *      pkill, killall).
 *   - ALLOW PID-based termination (Stop-Process -Id, taskkill /PID,
 *     Get-CimInstance ... | Stop-Process -Id $_.ProcessId).
 *   - Escape hatch: include the marker KILL_BY_NAME_OK in the command when a
 *     name-based kill is genuinely intended and the blast radius is understood.
 */
'use strict';

const MARKER = 'KILL_BY_NAME_OK';

// Each rule: what it matches, and the PID-based form to use instead.
const DENY_RULES = [
  {
    re: /\bStop-Process\b(?=[^|;\r\n]*?\s-Name\b)/i,
    what: 'Stop-Process -Name',
    instead: 'Stop-Process -Id <pid>  (resolve the PID you created, then kill that one)',
  },
  {
    re: /\b(?:spps|kill)\b(?=[^|;\r\n]*?\s-Name\b)/i,
    what: 'a Stop-Process alias with -Name',
    instead: 'Stop-Process -Id <pid>',
  },
  {
    re: /\bGet-Process\b(?![^|;\r\n]*?-Id\b)[^|;\r\n]*\|\s*(?:Stop-Process|spps|kill)\b/i,
    what: 'Get-Process <name> piped into Stop-Process',
    instead:
      'Get-Process -Id <pid> | Stop-Process, or capture the PID when you start the process',
  },
  {
    re: /\btaskkill\b[^\r\n]*?\/IM\b/i,
    what: 'taskkill /IM (image name)',
    instead: 'taskkill /F /PID <pid>',
  },
  { re: /\bpkill\b/i, what: 'pkill (matches by name/pattern)', instead: 'kill <pid>' },
  { re: /\bkillall\b/i, what: 'killall (kills every match)', instead: 'kill <pid>' },
];

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
  if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);

  const cmd = String((input.tool_input || {}).command || '');
  if (!cmd) process.exit(0);
  if (cmd.includes(MARKER)) process.exit(0);

  for (const rule of DENY_RULES) {
    if (rule.re.test(cmd)) {
      deny(
        `process-kill-guard: blocked ${rule.what} — it matches by name, so it cannot tell your ` +
          `process from one the user is using. On 2026-08-12 exactly this killed a real Notepad ` +
          `session with ~40 tabs and unsaved work while a test cleaned up after itself. ` +
          `Use: ${rule.instead}. Capture the PID when you START the process; do not look it up ` +
          `by name afterwards. If a name-based kill is genuinely required and you understand the ` +
          `blast radius, append the marker  # ${MARKER}  to the command.`,
      );
      process.exit(0);
    }
  }

  process.exit(0);
})();
