#!/usr/bin/env node
// correction-tracker.cjs — UserPromptSubmit
// Genesis-latency fix: "NEVER quiz me" took ~8 corrections across 6 months to become a
// rule because promotion depended on Wes noticing the repetition. This hook buckets
// correction-shaped prompts into corrections.jsonl; on the 2nd occurrence of a bucket
// it injects context ordering the session to draft the CLAUDE.md rule line NOW and
// present it for approval. A bucket marked {"bucket":"<name>","promoted":true} stops
// nagging. The log doubles as the fire-signal instrument for Tier 2 rules: a rule
// works iff its bucket stops accruing records.
// Ported from correction-tracker.ps1 on 2026-09-06: pwsh -NoProfile cost 246 ms per
// prompt, node costs 45 ms. Same buckets, same log file, same output text.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let evt;
try { evt = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const p = String(evt.prompt || '');
if (!p.trim() || p.length > 4000) process.exit(0);

const buckets = [
  ['decide-dont-quiz', /(stop\s+(fucking\s+)?(quizzing|testing)\s+me|don'?t\s+ask\s+me|you\s+(decide|choose)\s|just\s+(decide|pick\s+one))/i],
  ['already-told-you', /(\bi\s+(already|just)\s+(told|said|asked)\s+you\b|how\s+many\s+times|you\s+keep\s+(doing|asking|using|adding))/i],
  ['run-it-yourself', /why\s+(can'?t|don'?t)\s+you\s+just\s+run/i],
  ['stop-doing-that', /\bstop\s+(fucking\s+)?(using|doing|running|touching|messing\s+with|fucking\s+with)\b/i],
  ['question-not-task', /(didn'?t\s+ask\s+you\s+to\s+(do|change|edit|build)|just\s+answer\s+(my|the)\s+question|only\s+asked\s+a\s+question)/i],
  ['still-broken', /(still\s+(broken|not\s+working|doesn'?t\s+work)|\bno\b.{0,15}just\s+tested\s+it\s+again)/i],
];
const hit = (buckets.find(([, re]) => re.test(p)) || [])[0];
if (!hit) process.exit(0);

const log = path.join(os.homedir(), '.claude', 'corrections.jsonl');
const snippet = p.slice(0, 200).replace(/[\r\n]+/g, ' ');
const rec = JSON.stringify({ ts: new Date().toISOString(), bucket: hit, cwd: String(evt.cwd || ''), snippet });
try { fs.appendFileSync(log, rec + '\n', 'utf8'); } catch { process.exit(0); }

let entries = [];
try {
  entries = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { /* fresh log */ }
const mine = entries.filter((e) => e.bucket === hit);
if (mine.some((e) => e.promoted === true)) process.exit(0);
const unpromoted = mine.filter((e) => !e.promoted);
const count = unpromoted.length;
if (count >= 2) {
  const dates = [...new Set(mine.map((e) => { const d = new Date(e.ts); return isNaN(d) ? String(e.ts) : d.toISOString().slice(0, 10); }))].join(', ');
  process.stdout.write(`CORRECTION RECURRENCE: the correction pattern '${hit}' has now fired ${count} times (${dates}) per ${log}. Standing policy: in THIS response, after handling the prompt, draft the one CLAUDE.md rule line that would have prevented this correction and show it to Wes for approval. If he approves, add it to CLAUDE.md and append {"bucket":"${hit}","promoted":true} as a new line to ${log} so this reminder stops.\n`);
}
process.exit(0);
