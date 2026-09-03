#!/usr/bin/env node
// batch-guard.cjs - PreToolUse [Bash|PowerShell|Read|Glob|Grep]
// Denies the 4th consecutive one-at-a-time probe. Profiled 2026-09-01 over 8
// sessions / 27h: 70% of tool turns made exactly one call, each a ~9s model
// round-trip plus ~2s of hooks; that serial pattern was the largest single cost.
// A rule in prose did not change it, so this makes it mechanical.
//
// A "single" turn = one assistant message with exactly one tool_use that is a
// Read/Glob/Grep or a shell command with one real statement. Batched = a message
// with 2+ tool_use blocks, or a shell command with 2+ real statements (cd/echo/
// printf do not count). Edit/Write/Agent/Skill etc. are transparent. A user
// message resets the streak.
//
// Override: a shell command carrying "# SEQ: <why this needs the previous output>"
// passes and is logged. Read/Glob/Grep have no override: issue them in parallel.
// Report: node batch-guard.cjs --report   (counts per day from the log)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.BATCH_GUARD_LOG || path.join(os.homedir(), '.claude', 'logs', 'batch-guard.log');
const LIMIT = parseInt(process.env.BATCH_GUARD_LIMIT || '3', 10); // deny when streak >= LIMIT
const TAIL_BYTES = 128 * 1024; // ~4 turns even with 30KB tool results
const SHELL = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
const PROBE = new Set(['Read', 'Glob', 'Grep']);

if (process.argv.includes('--report')) { report(); process.exit(0); }

function realStatements(cmd) {
  return String(cmd).split(/\n|;|&&|\|\|/).map((s) => s.trim())
    .filter((s) => s && !/^(cd|echo|printf|set|export|pushd|popd|then|do|fi|done|else)\b/.test(s) && !/^[{}()]+$/.test(s)).length;
}
function isSingle(name, input) {
  if (PROBE.has(name)) return true;
  if (SHELL.has(name)) return realStatements(input && input.command) < 2;
  return null; // transparent
}
function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return len < size ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}
// Returns [{kind:'user'|'assistant', tools:[{name,input}]}] in order, assistant
// lines grouped by message.id (Claude Code writes one line per content block).
function messages(text) {
  const out = [];
  let lastId = null;
  for (const line of text.split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'user') {
      const c = j.message && j.message.content;
      const isResult = Array.isArray(c) && c.length && c[0].type === 'tool_result';
      if (!isResult) out.push({ kind: 'user' });
      lastId = null;
    } else if (j.type === 'assistant') {
      const id = j.message && j.message.id;
      if (id !== lastId || !out.length || out[out.length - 1].kind !== 'assistant') { out.push({ kind: 'assistant', tools: [] }); lastId = id; }
      for (const b of (j.message && j.message.content) || []) if (b.type === 'tool_use') out[out.length - 1].tools.push({ name: b.name, input: b.input });
    }
  }
  return out;
}
function streakBefore(msgs) {
  // msgs[last] is the current turn; count consecutive single turns before it.
  let n = 0;
  for (let i = msgs.length - 2; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === 'user') break;
    if (m.tools.length >= 2) break;
    if (m.tools.length === 0) continue; // narration between calls
    const s = isSingle(m.tools[0].name, m.tools[0].input);
    if (s === null) continue;
    if (!s) break;
    n++;
  }
  return n;
}
function log(kind, streak, sid, head) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, [new Date().toISOString(), kind, streak, String(sid || '').slice(0, 8), head.replace(/\s+/g, ' ').slice(0, 160)].join('\t') + '\n');
  } catch {}
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
function report() {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); } catch {}
  const days = {};
  for (const l of lines) { const [ts, kind] = l.split('\t'); const d = ts.slice(0, 10); (days[d] = days[d] || { deny: 0, seq: 0 })[kind === 'deny' ? 'deny' : 'seq']++; }
  console.log('batch-guard: ' + lines.length + ' events logged');
  for (const d of Object.keys(days).sort()) console.log('  ' + d + '  denied=' + days[d].deny + '  seq-overrides=' + days[d].seq);
}

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const name = input.tool_name || '';
const ti = input.tool_input || {};
if (!SHELL.has(name) && !PROBE.has(name)) process.exit(0);
if (!input.transcript_path) process.exit(0); // other harness: fail open

const single = isSingle(name, ti);
if (!single) process.exit(0); // already batched

let msgs;
try { msgs = messages(readTail(input.transcript_path)); } catch { process.exit(0); }
const cur = msgs.length ? msgs[msgs.length - 1] : null;
if (!cur || cur.kind !== 'assistant') process.exit(0); // current turn not written yet: cannot judge
if (cur.tools.length >= 2) process.exit(0); // parallel calls this turn

const streak = streakBefore(msgs);
if (streak < LIMIT) process.exit(0);

const head = SHELL.has(name) ? String(ti.command || '') : name + ' ' + (ti.file_path || ti.pattern || '');
const seq = SHELL.has(name) && /#\s*SEQ:\s*\S/.test(head);
if (seq) { log('seq', streak, input.session_id, head); process.exit(0); }

log('deny', streak, input.session_id, head);
deny('batch-guard: this is the ' + (streak + 1) + 'th consecutive one-at-a-time call (' + streak + ' single ' + (PROBE.has(name) ? 'probe' : 'command') + ' turns before it). Each costs a full model round-trip. Put the next several independent checks in ONE Bash call (chain with ; and print a header per section) or issue them as parallel tool calls in one message. If this call genuinely needs the previous result, re-issue it as a Bash command ending in "# SEQ: <what output it depends on>".');
process.exit(0);
