#!/usr/bin/env node
'use strict';
/*
 * mods-liveness.cjs — UserPromptSubmit, once per session.
 *
 * The Function Hooks layer (~/.claude/mods) announces itself by writing
 * mods/state/sessions/<session_id>.json at session.start. This hook is the classic-side witness:
 * on the FIRST prompt of a session it checks that heartbeat exists and is healthy. If the layer
 * did not load (plugin disabled, Function Hooks gated off after an update, worker crash), or loaded
 * unhealthy, it says so to Wes (systemMessage) and to the model (additionalContext), and records the
 * miss in mods/state/liveness.jsonl so a silent failure is never a clean-looking session.
 *
 * Fail-safe: any error → no output, exit 0. Never blocks a prompt.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readConfig, DEFAULTS } = require('./lib/mods-mode.cjs');

const HOME = process.env.USERPROFILE || os.homedir();
const STATE = path.join(HOME, '.claude', 'mods', 'state');

function main() {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  const sid = String(data.session_id || '').trim();
  if (!sid) return;
  const marker = path.join(STATE, 'liveness', sid + '.seen');
  try { if (fs.existsSync(marker)) return; fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, '1'); } catch (_) { return; }

  const cfg = readConfig();
  const modes = cfg.broken ? {} : cfg.guards;
  const enforcing = Object.keys(DEFAULTS).filter((g) => modes[g] === 'mod');
  let hb = null;
  try { hb = JSON.parse(fs.readFileSync(path.join(STATE, 'sessions', sid + '.json'), 'utf8')); } catch (_) { hb = null; }

  let problem = null;
  if (!hb) problem = 'the Function Hooks layer (harness-mods) wrote no heartbeat for this session: it did not load';
  else if (hb.runtime !== true) problem = 'harness-mods loaded but the harness-runtime adapter noun is missing (load order or adapter failure)';
  else if (hb.canary && hb.canary.ok === false) problem = 'harness-mods loaded unhealthy: ' + (hb.canary.failures || []).join('; ');
  else if (enforcing.some((g) => !(hb.armed && hb.armed[g] === true))) problem = 'guards in mod mode are not armed this session: ' + enforcing.filter((g) => !(hb.armed && hb.armed[g] === true)).join(', ');

  try { fs.appendFileSync(path.join(STATE, 'liveness.jsonl'), JSON.stringify({ ts: new Date().toISOString(), session: sid, ok: !problem, problem, enforcing, heartbeat: !!hb }) + '\n'); } catch (_) {}
  if (!problem) return;
  const msg = '[mods-liveness] ' + problem + '. Classic guards are enforcing (' + (enforcing.length ? enforcing.join(', ') + ' fall back to classic' : 'no guard is in mod mode') + '). Check: node ~/.claude/mods/canary.cjs';
  process.stdout.write(JSON.stringify({ systemMessage: 'MODS LAYER NOT HEALTHY: ' + problem + '. Classic guards are enforcing. Run: node ~/.claude/mods/canary.cjs', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } }));
}
try { main(); } catch (_) { /* fail-safe */ }
