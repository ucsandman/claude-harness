#!/usr/bin/env node
/**
 * opus-handoff-inject.cjs — auto-inject ~/.claude/docs/opus-handoff.md into
 * Opus sessions so the user never has to @-reference it manually.
 *
 * Detection (neither SessionStart payload nor env carries the model — verified
 * empirically 2026-07-05):
 *  - SessionStart: read the persisted "model" key from ~/.claude/settings.json
 *    (where /model selections are saved). Opus model -> inject.
 *  - UserPromptSubmit: read the latest assistant message's "model" from the
 *    session transcript (covers --model CLI flag and mid-session /model
 *    switches, effective from the prompt after the first reply).
 *
 * Injects at most once per session (marker file). Fail-safe: errors exit 0.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HANDOFF = path.join(CLAUDE_DIR, 'docs', 'opus-handoff.md');
const MARK_DIR = path.join(CLAUDE_DIR, 'opus-handoff-injected');
const SETTINGS = process.env.OPUS_HANDOFF_SETTINGS || path.join(CLAUDE_DIR, 'settings.json');
const MAX_MARK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isOpus = (m) => typeof m === 'string' && m.toLowerCase().includes('opus');

function settingsModelIsOpus() {
  try {
    return isOpus(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).model);
  } catch {
    return false;
  }
}

// Latest assistant-message model from the transcript (scan the tail).
function transcriptModelIsOpus(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (start > 0 && i === 0) break; // first line may be truncated by the tail window
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && obj.message && obj.message.model) return isOpus(obj.message.model);
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function inject(sessionId) {
  const mark = path.join(MARK_DIR, `${sessionId}`);
  if (fs.existsSync(mark)) return;
  const content = fs.readFileSync(HANDOFF, 'utf8'); // throws -> silent exit, no marker
  fs.mkdirSync(MARK_DIR, { recursive: true });
  fs.writeFileSync(mark, new Date().toISOString());
  try {
    for (const f of fs.readdirSync(MARK_DIR)) {
      const fp = path.join(MARK_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_MARK_AGE_MS) fs.unlinkSync(fp);
    }
  } catch {}
  console.log(`[opus-handoff] This session is running on Opus. The following standing rules apply (source: ${HANDOFF}):\n\n${content}`);
}

function main() {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!data.session_id) return;
  if (data.hook_event_name === 'SessionStart') {
    if (settingsModelIsOpus()) inject(data.session_id);
  } else if (data.hook_event_name === 'UserPromptSubmit') {
    if (data.transcript_path && transcriptModelIsOpus(data.transcript_path)) inject(data.session_id);
  }
}

try {
  main();
} catch {}
process.exit(0);
