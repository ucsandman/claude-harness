#!/usr/bin/env node
/**
 * engine/hooks/prompt-dispatch.cjs — ONE process for every UserPromptSubmit hook.
 *
 * Before 2026-09-19 settings.json spawned eight processes per prompt (seven node,
 * one python). Under load a bare `node -e 0` took 2.6 s on this machine, so each
 * hook blew its 5 s budget, the transcript filled with "hook timed out ... output
 * discarded", and every wake-up of a waiting session repeated the whole set.
 *
 * This file is the only UserPromptSubmit command. It reads the payload once, runs
 * each hook in-process (the hooks are unchanged: they still read fd 0, write
 * stdout and call process.exit; those three are intercepted around each require),
 * merges their outputs into one JSON answer, and times each one into a ledger.
 *
 *   node prompt-dispatch.cjs            # hook: JSON on stdin, JSON on stdout
 *   node prompt-dispatch.cjs --report   # last runs: per-hook ms, slow hooks
 *   node prompt-dispatch.cjs --list     # the hook chain
 *
 * Fail-open: a hook that throws is skipped and logged; the dispatcher itself
 * always exits 0. The wake-up guard (wakeup-guard.cjs) is part of the chain, so
 * a session that is woken by Monitor/ScheduleWakeup/task notifications with no
 * human prompt between them is told to stop answering "Waiting.".
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || os.homedir();
const LEDGER = path.join(HOME, '.claude', 'state', 'prompt-dispatch.jsonl');
const SLOW_MS = 1500;

// Order matters only for the merged additionalContext (top to bottom).
// { file, argv?: extra process.argv entries, exportedMain?: call module.exports.main(payload) instead of loading top-level }
const CHAIN = [
  { file: 'wakeup-guard.cjs', exportedMain: true },
  { file: 'opening-move.cjs', exportedMain: true },
  { file: 'scope-lock.cjs' },
  { file: 'opus-handoff-inject.cjs' },
  { file: 'correction-tracker.cjs' },
  { file: 'repeat-tool-guard.cjs', argv: ['--reset'] },
  { file: 'fable-delegate-guard.cjs', exportedMain: true },
  { file: 'mods-liveness.cjs' },
  { file: 'context-graph.cjs' },
];

class HookExit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

/** Run one hook file in this process with stdin, stdout and exit intercepted. Returns { out: string[], ms, error }. */
function runHook(entry, payloadText, payload) {
  const file = path.join(__dirname, entry.file);
  const out = [];
  const t0 = Date.now();
  const saved = {
    readFileSync: fs.readFileSync,
    exit: process.exit,
    write: process.stdout.write,
    log: console.log,
    argv: process.argv,
  };
  fs.readFileSync = function (p, ...rest) { return p === 0 ? payloadText : saved.readFileSync.call(fs, p, ...rest); };
  process.exit = (code) => { throw new HookExit(code || 0); };
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  console.log = (...args) => { out.push(args.join(' ') + '\n'); };
  process.argv = [saved.argv[0], file, ...(entry.argv || [])];
  let error = null;
  try {
    if (entry.exportedMain) {
      const mod = require(file);
      const r = mod.main(payload);
      if (r) out.push(String(r));
    } else {
      delete require.cache[file];
      require(file);
    }
  } catch (e) {
    if (!(e instanceof HookExit)) error = String(e && e.stack || e).split('\n').slice(0, 3).join(' | ');
  } finally {
    fs.readFileSync = saved.readFileSync;
    process.exit = saved.exit;
    process.stdout.write = saved.write;
    console.log = saved.log;
    process.argv = saved.argv;
  }
  return { out, ms: Date.now() - t0, error };
}

/** Merge each hook's stdout into one UserPromptSubmit answer. JSON lines contribute their fields; plain lines are context. */
function merge(results) {
  const context = [];
  const system = [];
  let block = null;
  for (const r of results) {
    const text = r.out.join('');
    if (!text.trim()) continue;
    let parsed = null;
    try { parsed = JSON.parse(text.trim()); } catch (_) { /* plain stdout */ }
    if (!parsed) { context.push(text.trim()); continue; }
    if (parsed.decision === 'block' && !block) block = parsed.reason || 'blocked by ' + r.name;
    if (parsed.systemMessage) system.push(String(parsed.systemMessage));
    const hs = parsed.hookSpecificOutput || {};
    if (hs.additionalContext) context.push(String(hs.additionalContext));
  }
  const answer = {};
  if (block) { answer.decision = 'block'; answer.reason = block; }
  if (system.length) answer.systemMessage = system.join(' | ');
  if (context.length) answer.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context.join('\n\n') };
  return answer;
}

function ledger(row) {
  try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n'); } catch (_) {}
}

/** Run the whole chain for one payload. Exported for the probe. */
function dispatch(payloadText, opts = {}) {
  let payload = {};
  try { payload = JSON.parse(payloadText); } catch (_) { return { answer: {}, results: [] }; }
  const chain = opts.chain || CHAIN;
  const results = [];
  for (const entry of chain) {
    const r = runHook(entry, payloadText, payload);
    results.push({ name: entry.file, ...r });
  }
  const answer = merge(results);
  const total = results.reduce((s, r) => s + r.ms, 0);
  if (!opts.noLedger) ledger({ ts: new Date().toISOString(), session: String(payload.session_id || '').slice(0, 8), source: payload.source || null, total, ms: Object.fromEntries(results.map((r) => [r.name, r.ms])), slow: results.filter((r) => r.ms >= SLOW_MS).map((r) => r.name), errors: Object.fromEntries(results.filter((r) => r.error).map((r) => [r.name, r.error])), context: answer.hookSpecificOutput ? answer.hookSpecificOutput.additionalContext.length : 0 });
  return { answer, results };
}

function report() {
  let rows = [];
  try { rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) {}
  if (!rows.length) { console.log('prompt-dispatch: 0 runs logged (' + LEDGER + ')'); return; }
  const last = rows.slice(-200);
  const per = {};
  for (const r of last) for (const [k, v] of Object.entries(r.ms || {})) (per[k] = per[k] || []).push(v);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`prompt-dispatch: ${rows.length} runs logged, last ${last.length}: median total ${med(last.map((r) => r.total))} ms, max ${Math.max(...last.map((r) => r.total))} ms`);
  for (const [k, v] of Object.entries(per).sort((a, b) => med(b[1]) - med(a[1]))) console.log(`  ${k.padEnd(28)} median ${String(med(v)).padStart(5)} ms  max ${String(Math.max(...v)).padStart(5)} ms`);
  const errs = last.filter((r) => Object.keys(r.errors || {}).length);
  if (errs.length) { console.log(`  ${errs.length} run(s) with a hook error; last:`); for (const [k, v] of Object.entries(errs[errs.length - 1].errors)) console.log(`    ${k}: ${v}`); }
}

if (require.main === module) {
  if (process.argv.includes('--report')) { report(); process.exit(0); }
  if (process.argv.includes('--list')) { for (const e of CHAIN) console.log(e.file + (e.argv ? ' ' + e.argv.join(' ') : '')); process.exit(0); }
  let text = '';
  try { text = fs.readFileSync(0, 'utf8'); } catch (_) {}
  let answer = {};
  try { answer = dispatch(text).answer; } catch (e) { ledger({ ts: new Date().toISOString(), fatal: String(e && e.message).slice(0, 200) }); }
  if (Object.keys(answer).length) process.stdout.write(JSON.stringify(answer));
  process.exit(0);
}

module.exports = { CHAIN, dispatch, merge, runHook, LEDGER };
