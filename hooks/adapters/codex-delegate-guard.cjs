#!/usr/bin/env node
'use strict';
/*
 * codex-delegate-guard.cjs — delegate-first enforcement for an Astra main loop
 * in Codex (SessionStart + UserPromptSubmit + PreToolUse Bash|apply_patch|spawn_agent).
 *
 * The Codex twin of engine/hooks/fable-delegate-guard.cjs. Wes runs gpt-6-astra
 * as the daily driver and wants it to spend tokens on briefs, decisions and
 * review while gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna children do the
 * hands-on work. Measured 2026-09-05: 224 Codex sessions, 33,407 shell calls,
 * 0 spawn_agent calls since June — the ladder existed in AGENTS.md and Astra
 * never climbed it. A rule that nothing enforces is a suggestion.
 *
 * Why a separate file and not the Fable guard: Codex hooks carry `model` on
 * every payload (no transcript sniffing), edits arrive as one apply_patch
 * command (not Edit/Write), the per-prompt key is `turn_id`, and the free
 * roots include ~/.codex. The shell-mutation classifier is shared: it is
 * required from the Fable guard so the two never drift.
 *
 * Model gate: payload.model matches /astra/ -> guarded. Anything else (a sol or
 * terra child, a session started with -m gpt-5.6-sol) -> allow, silently.
 *
 * Rules while guarded:
 *   - Bash: code-writing (redirects, heredocs, sed -i, tee, inline node/python
 *     writers, cp/mv/rm) outside ~/.claude, ~/.codex, ~/.agnostic and temp is
 *     denied. Reads, tests, lint, git, installs stay allowed.
 *   - apply_patch: budgeted per turn. PATCH_BUDGET patches of at most
 *     SMALL_PATCH_LINES added lines each; a patch that only touches the free
 *     roots does not count. Bigger, or over budget -> denied with the routing
 *     rule in the reason.
 *   - spawn_agent: a child on an astra model is denied unless agent_type is
 *     `advisor` (the one sanctioned astra consultation). Applies whatever the
 *     caller's model is. NOT LIVE in Codex 0.153.4: collaboration tools do not
 *     pass through PreToolUse (verified 2026-09-05, a real spawn logged nothing).
 *     Kept so it switches on the day Codex hooks them; until then the routing
 *     rule in AGENTS.md is prose.
 *
 * Override one shell command: append `# ASTRA_OK: <why>` (logged).
 * Wes saying "hands-on" in a prompt suspends the guard for the session;
 * "delegate again" restores it. Session off switch: CODEX_DELEGATE_GUARD=off.
 * Report: node codex-delegate-guard.cjs --report
 * Fail-open: any error means no output, exit 0, the tool runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const FABLE_GUARD = path.join('C:', 'Projects', 'agnostic-ai', 'engine', 'hooks', 'fable-delegate-guard.cjs');
const STATE_DIR = path.join(HOME, '.agnostic', 'codex-delegate-guard');
const LOG_PATH = path.join(HOME, '.agnostic', 'codex-delegate-guard.jsonl');

const GUARDED = /astra/i;
const PATCH_BUDGET = 12;
const SMALL_PATCH_LINES = 120;
const MIN_WAIT_MS = 600000;
const MARKER = /#\s*ASTRA_OK:\s*([^\n]*)/i;
const HANDS_ON = /\b(hands[- ]on|do (it|this|everything) yourself|fix (it|this|everything) yourself|line by line)\b/i;
const HANDS_OFF = /\b(delegate again|delegate-first again|hands off)\b/i;
const MAX_MARK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ROUTING = 'Route by complexity: spawn_agent agent_type "sonnet-implementer" (gpt-5.6-terra) for a scoped slice (one feature, one test file, a refactor inside named files, a review of one diff); "opus-owner" (gpt-5.6-sol) when the job spans many files, needs a root-cause hunt, touches auth/billing/migrations, or a terra attempt already failed; "haiku-scout" (gpt-5.6-luna) for greps, inventories, "where is X" and mechanical edits across files; "advisor" (astra) only for one focused architecture or security judgment, max 3 per session. Never spawn a bare astra worker.';

const BRIEFING = `[codex-delegate-guard] This main loop runs on gpt-6-astra, the expensive rung. Delegate-first: hand every implementation, exploration and long-output job to a child and keep only the brief, the decisions, the review and the final answer here. ${ROUTING} Give a child a clean context (fork_turns "none") and a precise brief: files, acceptance criteria, the verify command; batch related small edits into one brief instead of one child per line. Collect with ONE wait_agent call, timeout_ms ${MIN_WAIT_MS} or more: every wait return is a full astra turn over the whole context (about 34k input tokens); three 10-second polls cost more than the child's whole job. Never poll, never run your own inventory commands before spawning when the child can do them. Enforced here: code-writing through the shell (redirects, heredocs, sed -i, tee, inline node/python writers) is denied outside ~/.claude, ~/.codex and temp; apply_patch is budgeted to ${PATCH_BUDGET} patches of <=${SMALL_PATCH_LINES} added lines per turn, so a fix-up stays here and a feature goes to a child. Override one shell command with \`# ASTRA_OK: <why>\` (logged). Wes saying "hands-on" in a prompt suspends the guard for the session; "delegate again" restores it.`;

const DENY_PREFIX = '[codex-delegate-guard] Delegate-first: this main loop runs on astra. ' + ROUTING + ' Allowed here: reads, tests, lint, git, writes under ~/.claude, ~/.codex and temp. Shell override for a genuinely trivial command: append `# ASTRA_OK: <why>` (logged). Session off switch: CODEX_DELEGATE_GUARD=off.';

// --- helpers -----------------------------------------------------------------

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function underAny(target, roots) {
  const t = norm(target);
  return roots.filter(Boolean).some((r) => {
    const root = norm(r);
    return root && (t === root || t.startsWith(root + '/'));
  });
}

function freeRoots() {
  return [path.join(HOME, '.claude'), path.join(HOME, '.codex'), path.join(HOME, '.agnostic'), os.tmpdir(), process.env.TEMP, process.env.TMP];
}

function logEvent(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

function stateFile(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, name);
}
function readInt(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}
function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

const sid = (p) => p.session_id || 'no-session';
const handsOnFile = (p) => stateFile(`${sid(p)}.handson`);
const injectedFile = (p) => stateFile(`${sid(p)}.injected`);
const patchCounter = (p) => stateFile(`${sid(p)}.${p.turn_id || 'turn'}.patches`);

// apply_patch: "*** Begin Patch" / "*** Update File: x" / "+added" / "*** End Patch".
function parsePatch(text) {
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) files.push(m[1].trim());
  const added = text.split('\n').filter((l) => l.startsWith('+')).length;
  return { files, added };
}

function isMutatingShell(command, cwd) {
  const shared = require(FABLE_GUARD); // shared classifier, single owner
  return shared.isMutatingShell(command, { tmpdir: os.tmpdir(), cwd });
}

// --- decision ----------------------------------------------------------------

function deny(payload, kind, detail, extra = '') {
  logEvent({ session_id: payload.session_id || null, turn_id: payload.turn_id || null, model: payload.model || null, tool_name: payload.tool_name, kind, detail: String(detail).slice(0, 160) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${DENY_PREFIX} Blocked: ${payload.tool_name} ${String(detail).slice(0, 120)}.${extra}`,
    },
  };
}

function decide(payload) {
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};

  // wait_agent: every return is a full main-loop turn over the whole context (~34k
  // input tokens measured 2026-09-05; three 10-second polls cost more than the
  // child's job). Force a long wait so the parent wakes once, when the child is done.
  if (/wait_agent$/.test(tool)) {
    const t = Number(input.timeout_ms);
    if (!(t >= MIN_WAIT_MS)) {
      logEvent({ session_id: payload.session_id || null, turn_id: payload.turn_id || null, model: payload.model || null, tool_name: tool, kind: 'wait-rewrite', detail: `timeout_ms ${input.timeout_ms} -> ${MIN_WAIT_MS}` });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `[codex-delegate-guard] wait_agent timeout raised to ${MIN_WAIT_MS} ms: each wait return costs a full turn; wake once, when the child is done.`,
          updatedInput: { ...input, timeout_ms: MIN_WAIT_MS },
        },
      };
    }
    return null;
  }

  // Telemetry: which non-shell tools reach PreToolUse at all (collab tools were
  // silent on 2026-09-05; this line settles it per Codex version).
  if (tool !== 'Bash' && tool !== 'apply_patch' && !/spawn_agent$/.test(tool)) {
    logEvent({ session_id: payload.session_id || null, model: payload.model || null, tool_name: tool, kind: 'seen' });
    return null;
  }

  // A child on the expensive model is waste whoever asked for it; advisor is the one exception.
  if (/spawn_agent$/.test(tool)) {
    const model = String(input.model || '');
    if (GUARDED.test(model) && input.agent_type !== 'advisor') {
      return deny(payload, 'deny-spawn-astra', `model=${model} agent_type=${input.agent_type || '(none)'}`, ' Drop the model field and pick an agent_type; the agent file fixes the model.');
    }
    logEvent({ session_id: payload.session_id || null, turn_id: payload.turn_id || null, model: payload.model || null, tool_name: tool, kind: 'spawn', detail: `${input.agent_type || '(default)'} ${model}`.trim() });
    return null;
  }

  if (String(process.env.CODEX_DELEGATE_GUARD || '').toLowerCase() === 'off') return null;
  if (!GUARDED.test(String(payload.model || ''))) return null;
  if (exists(handsOnFile(payload))) return null;

  if (tool === 'apply_patch') {
    const { files, added } = parsePatch(String(input.command || ''));
    const cwd = payload.cwd || process.cwd();
    const abs = files.map((f) => (path.isAbsolute(f) || /^[a-z]:[\\/]/i.test(f) ? f : path.resolve(cwd, f)));
    if (abs.length && abs.every((f) => underAny(f, freeRoots()))) return null;
    const counter = patchCounter(payload);
    const used = readInt(counter);
    if (used < PATCH_BUDGET && added <= SMALL_PATCH_LINES) {
      try { fs.writeFileSync(counter, String(used + 1), 'utf8'); } catch (_) {}
      return null;
    }
    return deny(payload, 'deny-patch', `${files.join(', ') || '(no file header)'} (+${added} lines)`,
      ` Direct patches of <=${SMALL_PATCH_LINES} added lines, ${PATCH_BUDGET} per turn, are allowed; this turn has used ${used} of ${PATCH_BUDGET}.`);
  }

  if (tool === 'Bash') {
    const command = String(input.command || '');
    if (!isMutatingShell(command, payload.cwd)) return null;
    const marker = command.match(MARKER);
    if (marker) {
      logEvent({ session_id: payload.session_id || null, turn_id: payload.turn_id || null, model: payload.model, tool_name: tool, kind: 'override', detail: command.slice(0, 160), why: (marker[1] || '').trim() });
      return null;
    }
    return deny(payload, 'deny-shell', command);
  }

  return null;
}

// --- briefing ----------------------------------------------------------------

function briefOnce(payload) {
  const mark = injectedFile(payload);
  if (exists(mark)) return '';
  try {
    fs.writeFileSync(mark, new Date().toISOString(), 'utf8');
    for (const f of fs.readdirSync(STATE_DIR)) {
      const fp = path.join(STATE_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_MARK_AGE_MS) fs.unlinkSync(fp);
    }
  } catch (_) {}
  return BRIEFING;
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function main(payload) {
  const event = payload.hook_event_name || (payload.tool_name ? 'PreToolUse' : '');
  if (event === 'PreToolUse') return decide(payload);
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return null;
  if (String(process.env.CODEX_DELEGATE_GUARD || '').toLowerCase() === 'off') return null;
  if (!GUARDED.test(String(payload.model || ''))) return null;

  const prompt = String(payload.prompt || '');
  if (event === 'UserPromptSubmit' && HANDS_OFF.test(prompt) && exists(handsOnFile(payload))) {
    try { fs.unlinkSync(handsOnFile(payload)); } catch (_) {}
    logEvent({ session_id: payload.session_id || null, kind: 'hands-off', detail: prompt.slice(0, 120) });
    return context(event, '[codex-delegate-guard] Delegate-first is back on for this session.');
  }
  if (event === 'UserPromptSubmit' && HANDS_ON.test(prompt)) {
    try { fs.writeFileSync(handsOnFile(payload), new Date().toISOString(), 'utf8'); } catch (_) {}
    logEvent({ session_id: payload.session_id || null, kind: 'hands-on', detail: prompt.slice(0, 120) });
    return context(event, '[codex-delegate-guard] Hands-on mode: the operator asked for direct work, so the delegate-first budget and the shell code-writing rule are suspended for the rest of this session. Edit directly. Say "delegate again" to restore the guard.');
  }
  const text = briefOnce(payload);
  return text ? context(event, text) : null;
}

function report() {
  let lines = [];
  try { lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean); } catch (_) {}
  const days = {};
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    const day = String(e.ts || '').slice(0, 10);
    const b = days[day] || (days[day] = { denied: 0, overrides: 0, spawns: 0, other: 0 });
    if (e.kind === 'override') b.overrides++;
    else if (e.kind === 'spawn') b.spawns++;
    else if (String(e.kind).startsWith('deny')) b.denied++;
    else b.other++;
  }
  console.log(`codex-delegate-guard: ${lines.length} events logged`);
  for (const d of Object.keys(days).sort()) {
    console.log(`  ${d}  denied=${days[d].denied}  overrides=${days[d].overrides}  spawns=${days[d].spawns}`);
  }
}

if (require.main === module) {
  if (process.argv.includes('--report')) { report(); process.exit(0); }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buffer += c; });
  process.stdin.on('end', () => {
    try {
      const out = main(buffer.trim() ? JSON.parse(buffer) : {});
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (err) {
      logEvent({ kind: 'error', detail: String(err && err.message).slice(0, 160) });
    }
    process.exit(0);
  });
}

module.exports = { main, decide, parsePatch, BRIEFING };
