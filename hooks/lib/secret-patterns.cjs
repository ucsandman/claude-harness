'use strict';
/*
 * Shared vendor-prefixed secret shapes.
 *
 * Extracted 2026-09-06 so the message-layer watch (output-secret-watch.cjs)
 * and the tool-result watch (tool-output-secret-watch.cjs) cannot drift apart.
 * A pattern added for one channel now covers both.
 *
 * Vendor-prefixed shapes only. No entropy heuristics, no file paths: a false
 * positive here cries wolf on every message and gets the whole thing disabled,
 * which is worse than not having it.
 */

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
  ['neon-url', /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{8,}@/g],
];

// Placeholders are the whole point of examples and docs. Alerting on them is
// the false-positive class that would get this turned off.
const PLACEHOLDER =
  /(?:XXXX|xxxx|\.\.\.|<[^>]+>|\bYOUR_|\bEXAMPLE\b|\bPLACEHOLDER\b|\bREDACTED\b|A{12,}|0{12,}|1234567890)/;

/**
 * Scan text for secret shapes. Returns [{kind, head, len}] — never the secret
 * itself, so a caller that logs the result cannot become the leak.
 */
function scanText(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.match(re) || []) {
      if (PLACEHOLDER.test(m)) continue;
      hits.push({ kind: name, head: m.slice(0, 8) + '…', len: m.length });
    }
  }
  return hits;
}

module.exports = { PATTERNS, PLACEHOLDER, scanText };
