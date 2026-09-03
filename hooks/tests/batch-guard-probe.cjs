#!/usr/bin/env node
// Self-check for batch-guard.cjs: builds synthetic transcripts and proves it
// both denies and allows (L1). Run: node ~/.claude/hooks/tests/batch-guard-probe.cjs
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = path.join(__dirname, '..', 'batch-guard.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-guard-probe-'));

let n = 0;
const line = (o) => JSON.stringify(o) + '\n';
const user = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const result = () => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + n }] } });
// One assistant message; each tool_use on its own line sharing message.id (as Claude Code writes them).
const asst = (tools, text) => {
  const id = 'msg_' + (++n);
  let s = '';
  if (text) s += line({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
  for (const t of tools) s += line({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: 't' + n, name: t.name, input: t.input }] } });
  return s;
};
const bash = (command) => ({ name: 'Bash', input: { command } });
const read = (file_path) => ({ name: 'Read', input: { file_path } });
const single = (cmd) => asst([bash(cmd)]) + result();

function run(label, want, transcript, tool) {
  const file = path.join(dir, label.replace(/\W+/g, '_') + '.jsonl');
  fs.writeFileSync(file, transcript);
  const payload = { tool_name: tool.name, tool_input: tool.input, transcript_path: file, session_id: 'probe' };
  const r = spawnSync('node', [G], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, BATCH_GUARD_LIMIT: '3', BATCH_GUARD_LOG: path.join(dir, 'probe.log') } });
  const got = /"deny"/.test(r.stdout) ? 'deny' : 'allow';
  const ok = got === want;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + ' -> ' + got + (ok ? '' : ' (want ' + want + ')'));
  return ok;
}
const three = user('go') + single('ls') + single('cat a') + single('git status');
const cases = [
  ['4th single after 3 singles', 'deny', three + asst([bash('wc -l x')]), bash('wc -l x')],
  ['4th single Read after 3 singles', 'deny', three + asst([read('a.js')]), read('a.js')],
  ['multi-statement after 3 singles', 'allow', three + asst([bash('ls; cat a; git status')]), bash('ls; cat a; git status')],
  ['cd && one cmd is still single', 'deny', three + asst([bash('cd /x && wc -l y')]), bash('cd /x && wc -l y')],
  ['parallel calls this turn', 'allow', three + asst([bash('wc -l x'), bash('wc -l y')]), bash('wc -l x')],
  ['only 2 singles before', 'allow', user('go') + single('ls') + single('cat a') + asst([bash('wc -l x')]), bash('wc -l x')],
  ['user message resets', 'allow', three + user('ok') + asst([bash('wc -l x')]), bash('wc -l x')],
  ['batched turn resets', 'allow', three + single('a; b; c') + single('ls') + asst([bash('wc -l x')]), bash('wc -l x')],
  ['Edit between singles is transparent', 'deny', user('go') + single('ls') + asst([{ name: 'Edit', input: {} }]) + result() + single('cat a') + single('git status') + asst([bash('wc -l x')]), bash('wc -l x')],
  ['narration between singles is transparent', 'deny', user('go') + single('ls') + asst([], 'checking...') + single('cat a') + single('git status') + asst([bash('wc -l x')]), bash('wc -l x')],
  ['SEQ marker override', 'allow', three + asst([bash('wc -l x # SEQ: needs the path printed above')]), bash('wc -l x # SEQ: needs the path printed above')],
  ['bare SEQ without reason', 'deny', three + asst([bash('wc -l x # SEQ:')]), bash('wc -l x # SEQ:')],
  ['Write tool not covered', 'allow', three + asst([{ name: 'Write', input: {} }]), { name: 'Write', input: {} }],
  ['no transcript path', 'allow', '', bash('ls')],
];
let fail = 0;
for (const [label, want, t, tool] of cases) if (!run(label, want, t, tool)) fail++;
const missing = run('missing transcript file', 'allow', '', bash('ls'));
if (!missing) fail++;
fs.rmSync(dir, { recursive: true, force: true });
console.log((fail ? 'FAILED ' + fail : 'all passed') + ' of ' + (cases.length + 1) + ' cases');
process.exit(fail ? 1 : 0);
