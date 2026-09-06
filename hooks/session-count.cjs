#!/usr/bin/env node
// session-count.cjs — SessionStart
// Warn when several Claude Code sessions are running at once. All sessions share ONE
// rate limit and each re-processes its own full context, so running 4 at once is ~4x
// the input cost. Heuristic: count transcripts modified within the last WINDOW_SEC
// seconds: main sessions at projects/<slug>/*.jsonl and their subagents at
// projects/<slug>/<session>/subagents/**.jsonl (a subagent is its own API consumer).
// Ported from session-count.py on 2026-09-06: its rglob walked every tool-results
// tree and cost 500 ms at session start; this targeted walk costs about 100 ms.
// Fail-safe by design: any error -> no output, exit 0.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const THRESHOLD = 4;
const WINDOW_SEC = 120;

function recent(fp) {
  try { return Date.now() - fs.statSync(fp).mtimeMs <= WINDOW_SEC * 1000 ? 1 : 0; } catch { return 0; }
}

// Bounded walk of a subagents dir: workflow transcripts sit under subagents/workflows/<run>/.
function walk(dir, depth) {
  let n = 0; let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) n += walk(fp, depth - 1); }
    else if (e.name.endsWith('.jsonl')) n += recent(fp);
  }
  return n;
}

function main() {
  try { fs.readFileSync(0, 'utf8'); } catch { /* stdin unused */ }
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return; }
  let active = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(projects, d.name)); } catch { continue; }
    for (const f of files) {
      const fp = path.join(projects, d.name, f);
      if (f.endsWith('.jsonl')) { active += recent(fp); continue; }
      active += walk(path.join(fp, 'subagents'), 4);
    }
  }
  if (active >= THRESHOLD) {
    const msg = `[session-budget] ~${active} Claude Code sessions look active right now (this one likely included). They share ONE rate limit and each re-processes its own full context, so running several at once multiplies token cost. If they don't need to run simultaneously, mention to Wes once that queueing them would spend the limit more evenly.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } }));
  }
}
try { main(); } catch { /* fail-safe */ }
