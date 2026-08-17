#!/usr/bin/env node
// repeat-tool-guard.cjs — PostToolUse hook. Counts consecutive identical tool
// calls and injects an escalating reminder. Advisory: it never blocks a call.
//
// The failure it watches: a model re-issues the same call with byte-identical
// arguments — re-running a failing grep, re-reading an unchanged file, polling a
// command that already answered — and each round trip burns tokens and wall
// clock without adding information. CLAUDE.md carried this as prose ("guard
// against no-op retries"), which is exactly the kind of rule a model reads and
// then does not follow. This makes it mechanical.
//
// Design source: docs/decisions/feature/2026-08-17-repeat-tool-call-guard.md
// Ported from the pattern in deepseek-ai/deepseek-harness (packages/guard).
//
// Env overrides: REPEAT_GUARD_OFF=1 disables, REPEAT_GUARD_THRESHOLDS=3,5,8

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-repeat-guard');
const THRESHOLDS = (process.env.REPEAT_GUARD_THRESHOLDS || '3,5,8')
  .split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 2);
const ARGS_PREVIEW_CHARS = 400;
const STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Bookkeeping tools are transparent to the chain: they neither increment nor
 * reset it. Without this, `grep X → TodoWrite → grep X` looks like two unrelated
 * calls and a real loop launders itself through its own note-taking.
 */
const TRANSPARENT = new Set(['TodoWrite', 'TaskUpdate', 'TaskCreate', 'ScheduleWakeup']);

/**
 * Tools whose identical repetition is legitimate: polling a background task,
 * re-reading a file the agent expects to have changed. Excluded outright.
 */
const EXEMPT = new Set(['TaskOutput', 'TaskGet', 'TaskList', 'Monitor', 'AskUserQuestion']);

/** Deep key-sort then stringify, so argument order cannot hide a repeat. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function statePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return path.join(STATE_DIR, `${safe}.json`);
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (raw.at || 0) > STATE_MAX_AGE_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, at: Date.now() }), 'utf8');
  } catch {
    // Best effort. A guard that cannot persist must never break the tool call.
  }
}

function reminder(tool, count, argsPreview, gentle) {
  if (gentle) {
    return `You have now called \`${tool}\` ${count} times in a row with identical arguments. `
      + `Read the previous result again — it has not changed and it will not change. `
      + `Either act on what it already told you, try a materially different approach, or stop and report what you found.`;
  }
  return `STOP REPEATING. \`${tool}\` has been called ${count} times consecutively with identical arguments:\n`
    + `${argsPreview}\n`
    + `These calls made no progress. Before calling this tool again: state what you expected to be different, `
    + `and what changed since the last call that would make it different. If nothing changed, change the approach — `
    + `a different tool, a different layer, added instrumentation — or finish with the evidence you already have.`;
}

function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (process.env.REPEAT_GUARD_OFF === '1' || !THRESHOLDS.length) process.exit(0);

  // UserPromptSubmit: a user interjection changes the context, so repetition
  // across it is not a loop. Clear the chain and say nothing.
  if (process.argv.includes('--reset')) {
    try { fs.unlinkSync(statePath(payload.session_id)); } catch { /* nothing to clear */ }
    process.exit(0);
  }

  const tool = payload.tool_name;
  if (!tool || EXEMPT.has(tool)) process.exit(0);
  if (TRANSPARENT.has(tool)) process.exit(0); // neither counts nor resets

  const file = statePath(payload.session_id);
  const key = `${tool}::${canonical(payload.tool_input ?? {})}`;
  const prev = readState(file);
  const count = prev && prev.key === key ? prev.count + 1 : 1;
  writeState(file, { key, count });

  if (!THRESHOLDS.includes(count)) process.exit(0);

  const argsText = canonical(payload.tool_input ?? {});
  const preview = argsText.length > ARGS_PREVIEW_CHARS
    ? `${argsText.slice(0, ARGS_PREVIEW_CHARS)}… (${argsText.length} chars)`
    : argsText;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminder(tool, count, preview, count === THRESHOLDS[0]),
    },
  }));
  process.exit(0);
}

main();
