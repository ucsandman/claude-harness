#!/usr/bin/env node
'use strict';
/*
 * MessageDisplay watch — the only output-side guard in this harness.
 *
 * Every other guard here is input-side: secret-guard scans tool inputs and
 * staged files, the git pre-commit chain scans commits. Nothing looks at what
 * the model PRINTS. The global agreement says "Never paste secrets into code,
 * comments, logs, docs, commits, or messages" and that rule had no enforcement
 * at the message layer at all.
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
 * Patterns are vendor-prefixed shapes only. No entropy heuristics and no file
 * paths: a false positive here cries wolf on every message and gets the whole
 * hook disabled, which is worse than not having it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'output-secret-alerts.jsonl');

const PATTERNS = [
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{24,}/g],
  ['openai', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g],
  ['stripe-live', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  // {30,} not {36,}: classic ghp_ tokens are 36 after the prefix, but the
  // fine-grained and server-to-server variants differ in length. The gh?_
  // prefix is distinctive enough to carry the match on its own.
  ['github-pat', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws-key-id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{20,}/g],
  ['google-api', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// Placeholders are the whole point of examples and docs. Redacting or alerting
// on them is the false-positive class that would get this hook turned off.
const PLACEHOLDER = /(?:XXXX|xxxx|\.\.\.|<[^>]+>|\bYOUR_|\bEXAMPLE\b|\bPLACEHOLDER\b|\bREDACTED\b|A{12,}|0{12,}|1234567890)/;

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let evt = {};
  try { evt = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const text = typeof evt.delta === 'string' ? evt.delta : '';
  if (!text) process.exit(0);

  const hits = [];
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.match(re) || []) {
      if (PLACEHOLDER.test(m)) continue;
      hits.push({ kind: name, head: m.slice(0, 8) + '…', len: m.length });
    }
  }
  if (!hits.length) process.exit(0);

  // Never write the secret itself to the audit log — that would be the leak.
  try {
    fs.appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(),
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
