#!/usr/bin/env node
'use strict';
/*
 * PreCompact guard — turns a CLAUDE.md rule into an enforced one.
 *
 * The rule (global agreement, Token and Context Discipline):
 *   "Never auto-compact. At 80% context, ask: 'Context at 80%. Compact now or
 *    continue?' Summarize what will be preserved vs lost before compacting."
 *
 * That was prose an agent had to remember across a long session, which is
 * exactly when a long session stops remembering things. Every other rule Wes
 * cared about this much got a hook: secret-guard, agent-model-guard,
 * scope-lock, process-kill-guard. This is that hook.
 *
 * Registered with matcher "auto" so a manually typed /compact is untouched.
 * The trigger check below is belt-and-braces: if the matcher ever stops
 * binding, a manual compact must still succeed, because blocking Wes's own
 * /compact would be worse than the problem this solves.
 *
 * Exit 2 blocks the compaction and feeds the message back.
 */

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(raw || '{}'); } catch { /* fall through to block */ }

  // PreCompact reports "manual" or "auto". Anything explicitly manual passes.
  const trigger = String(evt.trigger || evt.matcher || evt.compact_trigger || '').toLowerCase();
  if (trigger === 'manual') process.exit(0);

  process.stderr.write(
    'Auto-compact is blocked by policy (~/.claude/CLAUDE.md, Token and Context Discipline).\n' +
    'Do NOT retry compaction. Instead, tell Wes: "Context at 80%. Compact now or continue?" ' +
    'and state what would be preserved vs lost. He decides. ' +
    'If he says compact, he types /compact himself (manual is allowed); /clear and /rewind are also his call.'
  );
  process.exit(2);
});
