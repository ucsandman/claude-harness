#!/usr/bin/env node
// declick-nudge.cjs — PreToolUse [mcp__.*|WebFetch]. Advisory, never blocks.
//
// The failure it watches: a raw MCP result, a WebFetch of a whole page, or a
// Chrome DOM read lands in context in full, every later turn re-reads it, and
// a declick adapter that answers the same question as trimmed JSON
// (--fields a,b --limit N) already sits in ~/.declick. The rule is prose in
// CLAUDE.md (declick first); this makes the reminder mechanical and cheap: one
// nudge per adapter per session, then silence.
//
// Mapping: mcp__<server>__<tool> -> the adapter whose directory exists under
// ~/.declick (SERVER_TO_ADAPTER below, plus the server name itself). The MCP
// tool name maps to the verb with underscores as dashes (search_news ->
// search-news), which is how declick names mcp verbs.
//
// Env: DECLICK_NUDGE_OFF=1 disables. Probe: hooks/tests/declick-nudge-probe.cjs
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.DECLICK_HOME || path.join(os.homedir(), '.declick');
const STATE_DIR = path.join(os.tmpdir(), 'claude-declick-nudge');
const STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** MCP server names that differ from their adapter name. */
const SERVER_TO_ADAPTER = {
  'dashclaw-local': 'dashclaw-mcp',
  'claude_ai_DashClaw': 'dashclaw-mcp',
  'plugin_context7_context7': 'c7',
};

/** Chrome tools that read a page: the element tree replaces them. */
const CHROME_READERS = new Set(['computer', 'read_page', 'get_page_text', 'find', 'navigate']);

function adapterExists(name) {
  try { return fs.statSync(path.join(HOME, name, 'manifest.json')).isFile(); } catch { return false; }
}

function statePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return path.join(STATE_DIR, `${safe}.json`);
}

function seen(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (raw.at || 0) > STATE_MAX_AGE_MS) return {};
    return raw.keys || {};
  } catch { return {}; }
}

function remember(file, keys) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keys, at: Date.now() }), 'utf8');
  } catch { /* best effort; a nudge that cannot persist must not break the call */ }
}

/** Returns { key, text } or null when there is nothing cheaper to point at. */
function advise(tool, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  if (m) {
    const server = m[1];
    const mcpTool = m[2];
    if (server === 'claude-in-chrome') {
      if (!CHROME_READERS.has(mcpTool)) return null;
      return {
        key: 'web',
        text: 'declick first: a page is a tree, not a screenshot or DOM dump. '
          + '`declick web tree <url> --selector <css> --limit 20` returns its links, buttons and inputs as JSON, '
          + 'and `declick web text <url> --grep <text>` answers "does the page say X", both at a fraction of a '
          + 'read_page/computer result. Use the Chrome tools only for a click, a form, or a visual (layout, canvas) question.',
      };
    }
    const adapter = SERVER_TO_ADAPTER[server] || server;
    if (!adapterExists(adapter)) return null;
    const verb = mcpTool.replace(/_/g, '-');
    return {
      key: adapter,
      text: `declick first: the \`${server}\` MCP server has a declick adapter (\`${adapter}\`). `
        + `From Bash, \`declick run ${adapter} ${verb} --help\` shows the flags and `
        + `\`declick run ${adapter} ${verb} <args> --fields a,b --limit N\` returns trimmed JSON `
        + 'instead of the full MCP payload; `declick describe '
        + `${adapter} --grep ${verb.split('-')[0]}\` lists the verbs. `
        + 'It works from every subagent, MCP does not.',
    };
  }
  if (tool === 'WebFetch') {
    const url = (input && input.url) || '<url>';
    return {
      key: 'web',
      text: 'declick first: for an HTML page, `declick web tree '
        + `${url} --selector <css> --limit 20\` returns its links, buttons and inputs as JSON and `
        + `\`declick web text ${url} --grep <text>\` answers "does the page say X", `
        + 'instead of the whole page through WebFetch. Keep WebFetch for a JSON or text endpoint, or when you '
        + 'need prose summarised.',
    };
  }
  return null;
}

function main() {
  if (process.env.DECLICK_NUDGE_OFF === '1') process.exit(0);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const hit = advise(payload.tool_name, payload.tool_input);
  if (!hit) process.exit(0);
  const file = statePath(payload.session_id);
  const keys = seen(file);
  if (keys[hit.key]) process.exit(0);
  keys[hit.key] = 1;
  remember(file, keys);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: hit.text },
  }));
  process.exit(0);
}

main();
