#!/usr/bin/env node
'use strict';
/*
 * PostToolUse watch — the tool-RESULT side of the secret guards.
 *
 * WHY THIS EXISTS (2026-09-06 incident): `env | grep -i "^ANTHROPIC"` printed a
 * live ANTHROPIC_API_KEY into the transcript and no guard in this harness said
 * a word. The coverage map had three guards and a hole:
 *
 *   secret-guard.cjs        PreToolUse     tool INPUTS + staged files
 *   pre-commit chain        commit time    commit contents
 *   output-secret-watch.cjs MessageDisplay assistant MESSAGE text
 *   (nothing)               PostToolUse    tool RESULTS   <-- the hole
 *
 * Tool results are the highest-volume text channel into a transcript and had
 * zero coverage. `env` is the canonical way to hit it, and that shape is now
 * denied at PreToolUse by secret-guard. This hook is the backstop for every
 * other route: a `cat` of the wrong file, a curl that echoes a token, a test
 * fixture, a script that prints its own config.
 *
 * This DETECTS, it does not redact. By the time PostToolUse fires, the result
 * is already in the transcript — the prevention lives in secret-guard. What
 * this adds is that the leak is never SILENT: an alert Wes sees, an audit line,
 * and additionalContext so the agent knows to stop echoing the value.
 *
 * Fails open: a bug here must never wedge a tool call.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanText } = require('./lib/secret-patterns.cjs');

const HOME = process.env.USERPROFILE || os.homedir();
const LOG = path.join(HOME, '.claude', 'output-secret-alerts.jsonl');

// Cap the scan. A giant tool result (a build log, a bundle dump) should cost
// milliseconds, not seconds; secrets appear near where they are printed.
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * The PostToolUse payload's result field name is not something to guess — it
 * has moved across versions and differs by tool. Serialize whatever the
 * payload holds under the known result-ish keys and scan the text. Anything
 * unrecognized still gets scanned via the whole-payload fallback, minus the
 * input we already know secret-guard vetted.
 */
function resultText(evt) {
  const candidates = [
    evt.tool_response,
    evt.tool_result,
    evt.tool_output,
    evt.response,
    evt.output,
    evt.result,
  ];
  const parts = [];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    parts.push(typeof c === 'string' ? c : safeStringify(c));
  }
  if (parts.length) return parts.join('\n').slice(0, MAX_SCAN_BYTES);
  // Fallback: scan the whole event minus the fields that are inputs, not output.
  const clone = { ...evt };
  delete clone.tool_input;
  delete clone.transcript_path;
  delete clone.cwd;
  return safeStringify(clone).slice(0, MAX_SCAN_BYTES);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) || '';
  } catch (_) {
    return String(v);
  }
}

let raw = '';
process.stdin.on('data', (d) => {
  raw += d;
});
process.stdin.on('end', () => {
  let evt = {};
  try {
    evt = JSON.parse(raw || '{}');
  } catch (_) {
    process.exit(0);
  }

  let hits = [];
  try {
    hits = scanText(resultText(evt));
  } catch (_) {
    process.exit(0); // fail open — never wedge a tool call over this
  }
  if (!hits.length) process.exit(0);

  const tool = evt.tool_name || 'unknown';
  const kinds = [...new Set(hits.map((h) => h.kind))].join(', ');

  // Never write the secret itself to the audit log — that would be the leak.
  try {
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        channel: 'tool_result',
        hook_event_name: evt.hook_event_name || 'PostToolUse',
        tool,
        cwd: evt.cwd || '',
        session_id: evt.session_id || '',
        hits,
      }) + '\n',
      'utf8'
    );
  } catch (_) {
    /* never break a tool call over a log write */
  }

  process.stdout.write(
    JSON.stringify({
      systemMessage:
        `SECRET SHAPE IN TOOL OUTPUT: ${hits.length} match(es) [${kinds}] came back from ${tool} ` +
        `and are now in the transcript. Logged to ~/.claude/output-secret-alerts.jsonl. ` +
        `Rotate the credential if it is real — the transcript cannot be retracted.`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `A secret shape (${kinds}) appeared in the output of ${tool}. Do NOT echo, ` +
          `summarize, quote, or write this value anywhere. Tell the user to rotate it, ` +
          `and do not re-run the command that produced it.`,
      },
    })
  );
  process.exit(0);
});
