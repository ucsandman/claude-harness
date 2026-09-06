#!/usr/bin/env node
'use strict';
/*
 * MessageDisplay watch — the MESSAGE-layer secret guard.
 *
 * Guards in this harness, by channel (map corrected 2026-09-06):
 *   secret-guard.cjs             PreToolUse     tool INPUTS + staged files
 *   pre-commit chain             commit time    commit contents
 *   output-secret-watch.cjs      MessageDisplay assistant MESSAGE text  <- this
 *   tool-output-secret-watch.cjs PostToolUse    tool RESULTS
 *
 * This file used to claim it was "the only output-side guard in this harness".
 * That wording hid a hole: it reads what the MODEL prints, never what a TOOL
 * returns. On 2026-09-06 `env | grep -i "^ANTHROPIC"` printed a live API key as
 * a Bash tool result and nothing fired. secret-guard now denies that command
 * shape and tool-output-secret-watch.cjs covers tool results generally.
 *
 * MEASURED CONTRACT (probed on v2.1.233, 2026-08-16 — the published field names
 * `message_text` / `message_role` do NOT exist):
 *   { session_id, transcript_path, cwd, prompt_id, hook_event_name,
 *     turn_id, message_id, index, final, delta }
 *   `delta` is a string holding the message text. Fires ONCE per assistant
 *   message with final:true, not once per streamed chunk. Cost is one node
 *   spawn (~78ms) per message.
 *
 * This DETECTS, it does not redact. MessageDisplay is display-only (exit 2 does
 * not block, the text still renders), and the contract for returning modified
 * text is undocumented — guessing it would risk silently mangling output. So
 * this raises a visible systemMessage and writes an audit line instead, which
 * needs no undocumented contract to work.
 *
 * Patterns live in lib/secret-patterns.cjs, shared with the tool-result watch
 * so the two channels cannot drift apart.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanText } = require('./lib/secret-patterns.cjs');

const LOG = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'output-secret-alerts.jsonl');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const text = typeof evt.delta === 'string' ? evt.delta : '';
  if (!text) process.exit(0);

  let hits = [];
  try { hits = scanText(text); } catch { process.exit(0); }
  if (!hits.length) process.exit(0);

  // Never write the secret itself to the audit log — that would be the leak.
  try {
    fs.appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(),
      channel: 'message',
      cwd: evt.cwd || '',
      message_id: evt.message_id || '',
      hits,
    }) + '\n', 'utf8');
  } catch { /* never break rendering over a log write */ }

  const kinds = [...new Set(hits.map((h) => h.kind))].join(', ');
  process.stdout.write(JSON.stringify({
    systemMessage: `SECRET SHAPE IN OUTPUT: ${hits.length} match(es) [${kinds}] just rendered. ` +
      `Logged to ~/.claude/output-secret-alerts.jsonl. Rotate if real, and do not paste this message anywhere.`,
  }));
  process.exit(0);
});
