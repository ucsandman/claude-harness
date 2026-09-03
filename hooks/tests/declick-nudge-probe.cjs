'use strict';
// declick-nudge-probe.cjs — does the declick nudge fire, once, and only where an adapter exists?
// Run: node hooks/tests/declick-nudge-probe.cjs

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOOK = 'C:/Users/sandm/.claude/hooks/declick-nudge.cjs';

// A fake ~/.declick so the probe does not depend on which adapters this box has.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'declick-probe-'));
for (const a of ['xapi', 'dashclaw-mcp', 'c7']) {
  fs.mkdirSync(path.join(HOME, a));
  fs.writeFileSync(path.join(HOME, a, 'manifest.json'), '{}');
}

let seq = 0;
const session = () => `probe-${Date.now()}-${seq++}`;

function call(sessionId, tool, input, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: sessionId, tool_name: tool, tool_input: input }),
    encoding: 'utf8',
    env: { ...process.env, DECLICK_HOME: HOME, ...env },
  });
  const out = (r.stdout || '').trim();
  if (!out) return null;
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch { return out; }
}

const CASES = [];
const add = (name, actual, want) => CASES.push([name, actual, want]);

// 1. An MCP tool with an adapter names the adapter and the dashed verb, once.
{
  const s = session();
  const a = call(s, 'mcp__xapi__search_news', { query: 'x' });
  add('xapi nudges', typeof a === 'string' && /declick run xapi search-news/.test(a), true);
  add('xapi second call silent', call(s, 'mcp__xapi__get_users_me', {}) === null, true);
}

// 2. Server-to-adapter renames.
add('dashclaw-local -> dashclaw-mcp', /declick run dashclaw-mcp dashclaw-guard/.test(call(session(), 'mcp__dashclaw-local__dashclaw_guard', {}) || ''), true);
add('context7 plugin -> c7', /declick run c7 resolve-library-id/.test(call(session(), 'mcp__plugin_context7_context7__resolve-library-id', {}) || ''), true);

// 3. A server with no adapter is silent.
add('unknown server silent', call(session(), 'mcp__sidetap__tap', {}) === null, true);

// 4. WebFetch carries the url; a chrome reader gets the web tree; a chrome click does not.
add('WebFetch nudges with url', /declick web tree https:\/\/example.com\/x --selector/.test(call(session(), 'WebFetch', { url: 'https://example.com/x' }) || ''), true);
add('chrome read_page nudges', /declick web tree/.test(call(session(), 'mcp__claude-in-chrome__read_page', {}) || ''), true);
add('chrome form_input silent', call(session(), 'mcp__claude-in-chrome__form_input', {}) === null, true);
{
  const s = session();
  call(s, 'WebFetch', { url: 'https://a.test' });
  add('web key shared: chrome after WebFetch silent', call(s, 'mcp__claude-in-chrome__read_page', {}) === null, true);
}

// 5. Off switch and a bad payload are silent.
add('DECLICK_NUDGE_OFF silent', call(session(), 'mcp__xapi__search_news', {}, { DECLICK_NUDGE_OFF: '1' }) === null, true);
{
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  add('bad payload silent, exit 0', r.status === 0 && !(r.stdout || '').trim(), true);
}

let fail = 0;
for (const [name, actual, want] of CASES) {
  const ok = actual === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)})`}`);
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${CASES.length - fail}/${CASES.length} passed`);
process.exit(fail ? 1 : 0);
