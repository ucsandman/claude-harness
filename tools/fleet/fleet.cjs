#!/usr/bin/env node
'use strict';

/*
 * fleet.cjs — Claude Code session monitor.
 *
 * Scans C:\Users\sandm\.claude\projects\<slug>\<session-uuid>.jsonl transcripts,
 * finds sessions active in the last 24h, and renders fleet.html showing which
 * sessions are live, what each is doing, and how heavy each is.
 *
 * Zero dependencies. See README.md for the tail-read design constraint.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUT_HTML = path.join(__dirname, 'fleet.html');

const TAIL_BYTES = 1048576; // 1 MB — busy sessions accumulate >250 KB of subagent
// notifications in minutes, pushing the last human ask out of a smaller tail
// (measured 2026-08-13: 294 KB from EOF on a live session)
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACTIVE_MS = 10 * 60 * 1000; // 10 minutes
const SNIPPET_LEN = 200;
const WATCH_INTERVAL_MS = 30 * 1000;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, len) {
  if (s.length <= len) return s;
  return s.slice(0, len) + '…';
}

// Extract plain text from a message.content value (string or array of blocks).
// Returns '' if the content has no text block (e.g. only tool_use/tool_result).
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

// Read only the last TAIL_BYTES of a file, split into lines, drop the first
// (likely partial) line when we didn't start at byte 0, parse each line as
// JSON individually, skip unparseable lines.
function readTailRecords(filePath, fileSize) {
  const readSize = Math.min(TAIL_BYTES, fileSize);
  const startOffset = fileSize - readSize;
  const fd = fs.openSync(filePath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, startOffset);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  let lines = text.split('\n');
  if (startOffset > 0) {
    lines = lines.slice(1); // drop partial first line
  }
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (e) {
      // skip unparseable lines
    }
  }
  return records;
}

// Harness-injected plumbing that arrives as user-role messages but isn't a
// human ask: task notifications, system reminders, slash-command echoes, etc.
const PLUMBING_PREFIXES = [
  '<task-notification>',
  '[SYSTEM NOTIFICATION',
  '<system-reminder>',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout',
  'Caveat: the messages below',
];

function isPlumbing(text) {
  const trimmed = text.trim();
  return PLUMBING_PREFIXES.some((p) => trimmed.startsWith(p));
}

// Walk records to find the latest user "ask" text and latest assistant
// "reply" text, skipping tool_use/tool_result-only entries and skipping
// harness-injected plumbing so the human's real last prompt surfaces.
function extractLastAskAndReply(records) {
  let lastAsk = '';
  let lastReply = '';
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || !rec.message) continue;
    // isMeta marks harness-injected content riding a user-role message (e.g.
    // skill bodies loaded via the Skill tool) that isn't a human prompt and
    // has no recognizable plumbing prefix — skip it the same way.
    if (rec.isMeta) continue;
    if (!lastAsk && rec.type === 'user' && rec.message.role === 'user') {
      const text = extractText(rec.message.content);
      if (text && !isPlumbing(text)) lastAsk = text;
    }
    if (!lastReply && rec.type === 'assistant' && rec.message.role === 'assistant') {
      const text = extractText(rec.message.content);
      if (text) lastReply = text;
    }
    if (lastAsk && lastReply) break;
  }
  return { lastAsk, lastReply };
}

function prettySlug(dirName) {
  return dirName.replace(/^C--/, '');
}

function formatRelative(ms) {
  const diffMs = Date.now() - ms;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return diffSec <= 1 ? 'just now' : `${diffSec} sec ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function scanSessions() {
  const sessions = [];
  if (!fs.existsSync(PROJECTS_DIR)) return sessions;

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const now = Date.now();

  for (const projectDir of projectDirs) {
    const fullProjectDir = path.join(PROJECTS_DIR, projectDir);
    let entries;
    try {
      entries = fs.readdirSync(fullProjectDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(fullProjectDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (e) {
        continue;
      }
      const mtimeMs = stat.mtimeMs;
      if (now - mtimeMs > WINDOW_MS) continue; // only last 24h

      let records = [];
      try {
        records = readTailRecords(filePath, stat.size);
      } catch (e) {
        continue;
      }

      const { lastAsk, lastReply } = extractLastAskAndReply(records);
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      const slug = prettySlug(projectDir);
      const isScratch = /Temp/i.test(projectDir);
      const isActive = now - mtimeMs <= ACTIVE_MS;

      sessions.push({
        sessionId,
        shortId: sessionId.slice(0, 8),
        slug,
        isScratch,
        sizeMB: stat.size / (1024 * 1024),
        mtimeMs,
        isActive,
        lastAsk: truncate(lastAsk, SNIPPET_LEN),
        lastReply: truncate(lastReply, SNIPPET_LEN),
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

function renderHtml(sessions) {
  const activeCount = sessions.filter((s) => s.isActive).length;
  const idleCount = sessions.length - activeCount;
  const generatedAt = new Date().toLocaleString();

  const rows = sessions.map((s) => {
    const dotClass = s.isActive ? 'dot-active' : 'dot-idle';
    const statusLabel = s.isActive ? 'active' : 'idle';
    const scratchBadge = s.isScratch ? '<span class="badge-scratch">scratch</span>' : '';
    return `
      <div class="row">
        <div class="cell cell-status"><span class="dot ${dotClass}" title="${statusLabel}"></span></div>
        <div class="cell cell-project">
          <div class="slug">${htmlEscape(s.slug)}${scratchBadge}</div>
          <div class="session-id">${htmlEscape(s.shortId)}</div>
        </div>
        <div class="cell cell-time">${htmlEscape(formatRelative(s.mtimeMs))}</div>
        <div class="cell cell-size">${s.sizeMB.toFixed(1)} MB</div>
        <div class="cell cell-ask"><span class="label">ask</span> ${htmlEscape(s.lastAsk) || '<span class="empty">(no recent ask in tail)</span>'}</div>
        <div class="cell cell-reply"><span class="label">reply</span> ${htmlEscape(s.lastReply) || '<span class="empty">(none)</span>'}</div>
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink-primary: #ffffff;
    --ink-secondary: #c3c2b7;
    --ink-muted: #898781;
    --border: rgba(255,255,255,0.10);
    --good: #0ca30c;
    --idle-dot: #898781;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  header {
    margin-bottom: 20px;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 4px 0;
  }
  .subhead {
    color: var(--ink-secondary);
    font-size: 14px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: 24px 200px 90px 80px 1fr 1fr;
    gap: 12px;
    align-items: start;
    background: var(--surface);
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child { border-bottom: none; }
  .cell-status { display: flex; align-items: center; height: 100%; padding-top: 2px; }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  .dot-active { background: var(--good); box-shadow: 0 0 6px rgba(12,163,12,0.6); }
  .dot-idle { background: var(--idle-dot); }
  .slug {
    font-weight: 600;
    word-break: break-word;
  }
  .session-id {
    color: var(--ink-muted);
    font-size: 11px;
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    margin-top: 2px;
  }
  .badge-scratch {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--ink-muted);
    border: 1px solid var(--border);
    vertical-align: middle;
  }
  .cell-time, .cell-size {
    color: var(--ink-secondary);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .cell-ask, .cell-reply {
    color: var(--ink-secondary);
    line-height: 1.4;
  }
  .label {
    color: var(--ink-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-right: 4px;
  }
  .empty { color: var(--ink-muted); font-style: italic; }
  footer {
    margin-top: 20px;
    color: var(--ink-muted);
    font-size: 12px;
  }
  @media (max-width: 900px) {
    .row {
      grid-template-columns: 20px 1fr;
      grid-template-areas:
        "status project"
        ".      time"
        ".      size"
        ".      ask"
        ".      reply";
    }
    .cell-status { grid-area: status; }
    .cell-project { grid-area: project; }
    .cell-time { grid-area: time; }
    .cell-size { grid-area: size; }
    .cell-ask { grid-area: ask; }
    .cell-reply { grid-area: reply; }
  }
</style>
</head>
<body>
<header>
  <h1>${activeCount} active session${activeCount === 1 ? '' : 's'} — they share one rate limit</h1>
  <div class="subhead">${sessions.length} session${sessions.length === 1 ? '' : 's'} in the last 24h (${activeCount} active, ${idleCount} idle) · generated ${htmlEscape(generatedAt)}</div>
</header>
<div class="rows">
${rows || '<div class="row" style="grid-template-columns: 1fr;"><div class="empty">No sessions active in the last 24 hours.</div></div>'}
</div>
<footer>
  Data refreshes only while <code>fleet --watch</code> is running (regenerates every 30s). Otherwise this is a static snapshot — re-run <code>node fleet.cjs</code> to refresh.
</footer>
</body>
</html>
`;
}

function generate() {
  const sessions = scanSessions();
  const html = renderHtml(sessions);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  const activeCount = sessions.filter((s) => s.isActive).length;
  const idleCount = sessions.length - activeCount;
  console.log(OUT_HTML);
  console.log(`${activeCount} active / ${idleCount} idle`);
  return { sessions, activeCount, idleCount };
}

function openFile(filePath) {
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const args = process.argv.slice(2);
  const doOpen = args.includes('--open');
  const doWatch = args.includes('--watch');

  generate();
  if (doOpen) openFile(OUT_HTML);

  if (doWatch) {
    console.log(`watching — regenerating every ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C to stop)`);
    setInterval(() => {
      const { activeCount, idleCount } = generate();
      console.log(`[${new Date().toLocaleTimeString()}] heartbeat: ${activeCount} active / ${idleCount} idle`);
    }, WATCH_INTERVAL_MS);
  }
}

main();
