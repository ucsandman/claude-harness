#!/usr/bin/env node
'use strict';
// Probe for hooks/adapters/codex-delegate-guard.cjs: every rule made to pass AND
// to fail on purpose (rule L1). Run: node ~/.claude/hooks/tests/codex-delegate-guard-probe.cjs
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const GUARD = path.join(__dirname, '..', 'adapters', 'codex-delegate-guard.cjs');
const S = `probe-${Date.now()}`;
const CWD = 'C:/Projects/probe-repo';
let failed = 0;

function run(payload) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}
const decision = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || 'allow';
const ctx = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '';

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const pre = (model, tool_name, tool_input, turn_id = 't1') =>
  ({ hook_event_name: 'PreToolUse', session_id: S, turn_id, model, cwd: CWD, tool_name, tool_input });
const patch = (file, added) => `*** Begin Patch\n*** Update File: ${file}\n@@\n${Array(added).fill('+x').join('\n')}\n*** End Patch`;
const ASTRA = 'gpt-6-astra', TERRA = 'gpt-5.6-terra';

check('astra shell redirect denied', decision(run(pre(ASTRA, 'Bash', { command: 'echo hi > src/a.ts' }))), 'deny');
check('astra heredoc denied', decision(run(pre(ASTRA, 'Bash', { command: "cat <<'EOF' > src/a.ts\nx\nEOF" }))), 'deny');
check('astra sed -i denied', decision(run(pre(ASTRA, 'Bash', { command: 'sed -i s/a/b/ src/a.ts' }))), 'deny');
check('astra test+git allowed', decision(run(pre(ASTRA, 'Bash', { command: 'npm test && git status && rg foo src' }))), 'allow');
check('astra redirect to temp allowed', decision(run(pre(ASTRA, 'Bash', { command: `npm test > ${os.tmpdir()}/t.log 2>&1` }))), 'allow');
check('astra ASTRA_OK override allowed', decision(run(pre(ASTRA, 'Bash', { command: 'echo hi > src/a.ts # ASTRA_OK: one liner' }))), 'allow');
check('terra child shell redirect allowed', decision(run(pre(TERRA, 'Bash', { command: 'echo hi > src/a.ts' }))), 'allow');
check('astra small patch allowed', decision(run(pre(ASTRA, 'apply_patch', { command: patch('src/a.ts', 5) }))), 'allow');
check('astra 200-line patch denied', decision(run(pre(ASTRA, 'apply_patch', { command: patch('src/b.ts', 200) }))), 'deny');
check('astra big patch under ~/.claude allowed', decision(run(pre(ASTRA, 'apply_patch', { command: patch('C:/Users/sandm/.claude/x.md', 200) }))), 'allow');
check('terra 200-line patch allowed', decision(run(pre(TERRA, 'apply_patch', { command: patch('src/b.ts', 200) }))), 'allow');
for (let i = 0; i < 12; i++) run(pre(ASTRA, 'apply_patch', { command: patch('src/a.ts', 1) }, 't2'));
check('astra 13th patch in a turn denied', decision(run(pre(ASTRA, 'apply_patch', { command: patch('src/a.ts', 1) }, 't2'))), 'deny');
check('astra 1st patch in next turn allowed', decision(run(pre(ASTRA, 'apply_patch', { command: patch('src/a.ts', 1) }, 't3'))), 'allow');
check('spawn bare astra worker denied', decision(run(pre(ASTRA, 'spawn_agent', { model: ASTRA, message: 'x' }))), 'deny');
check('spawn advisor on astra allowed', decision(run(pre(ASTRA, 'spawn_agent', { model: ASTRA, agent_type: 'advisor', message: 'x' }))), 'allow');
check('spawn sonnet-implementer allowed', decision(run(pre(ASTRA, 'spawn_agent', { agent_type: 'sonnet-implementer', message: 'x' }))), 'allow');
check('spawn astra from terra child denied', decision(run(pre(TERRA, 'spawn_agent', { model: ASTRA, message: 'x' }))), 'deny');

const w = run(pre(ASTRA, 'wait_agent', { timeout_ms: 10000 }));
check('wait_agent 10s rewritten to 600s', w && w.hookSpecificOutput.permissionDecision === 'allow' && w.hookSpecificOutput.updatedInput.timeout_ms, 600000);
check('wait_agent 900s left alone', run(pre(ASTRA, 'wait_agent', { timeout_ms: 900000 })), null);
check('wait_agent no timeout rewritten', run(pre(ASTRA, 'wait_agent', {})).hookSpecificOutput.updatedInput.timeout_ms, 600000);
check('wait_agent rewrite applies to terra too', run(pre(TERRA, 'collaboration.wait_agent', { timeout_ms: 5000 })).hookSpecificOutput.updatedInput.timeout_ms, 600000);

check('SessionStart astra briefs', ctx(run({ hook_event_name: 'SessionStart', session_id: S, model: ASTRA, source: 'startup' })).startsWith('[codex-delegate-guard] This main loop runs on gpt-6-astra'), true);
check('SessionStart astra briefs once', ctx(run({ hook_event_name: 'SessionStart', session_id: S, model: ASTRA, source: 'resume' })), '');
check('SessionStart sol silent', ctx(run({ hook_event_name: 'SessionStart', session_id: `${S}-sol`, model: 'gpt-5.6-sol', source: 'startup' })), '');
check('hands-on acknowledged', ctx(run({ hook_event_name: 'UserPromptSubmit', session_id: S, model: ASTRA, prompt: 'just do it hands-on' })).includes('Hands-on mode'), true);
check('hands-on lifts shell rule', decision(run(pre(ASTRA, 'Bash', { command: 'echo hi > src/a.ts' }, 't4'))), 'allow');
check('delegate again restores', ctx(run({ hook_event_name: 'UserPromptSubmit', session_id: S, model: ASTRA, prompt: 'ok delegate again' })).includes('back on'), true);
check('shell rule back', decision(run(pre(ASTRA, 'Bash', { command: 'echo hi > src/a.ts' }, 't5'))), 'deny');
check('env off switch', decision((() => { const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(pre(ASTRA, 'Bash', { command: 'echo hi > src/a.ts' }, 't6')), encoding: 'utf8', env: { ...process.env, CODEX_DELEGATE_GUARD: 'off' } }); return r.stdout.trim() ? JSON.parse(r.stdout) : null; })()), 'allow');

console.log(`\ncodex-delegate-guard probe: ${failed === 0 ? 'PASSED' : 'FAILED'} (${failed} failures of 29 checks)`);
process.exit(failed ? 1 : 0);
