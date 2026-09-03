#!/usr/bin/env node
/**
 * engine/hooks/capability-graph-guard.cjs — capability-graph enforcement for
 * Claude Code subagents (PreToolUse + SubagentStart + SubagentStop).
 *
 * The graph:  Fable -> Opus, Sonnet, Haiku;  Opus -> Sonnet, Haiku;
 *             Sonnet -> Haiku;  Haiku -> nobody.
 * Delegation flows downward only. Peers are not edges: a Sonnet subagent
 * spawning another Sonnet buys nothing and hides the work one level deeper.
 *
 * The single upward edge is consultation, not delegation: any caller above
 * Haiku may spawn subagent_type "advisor" (read-only, returns guidance and
 * never owns the task), capped at 2 per calling agent and 3 per session so it
 * stays inside the operator's own Fable spawn cap.
 *
 * The advisor is always ONE RUNG ABOVE ITS CALLER (Wes, 2026-09-03): Sonnet
 * consults Opus, Opus consults Fable, Fable consults Fable. A peer advisor
 * shares the caller's blind spots; a Fable advisor for a Sonnet worker burns
 * Fable tokens where Opus would have done the job. So this guard ignores any
 * model the caller passed and injects the escalated one through the
 * PreToolUse `updatedInput` envelope (the Agent tool's explicit `model`
 * parameter wins over agents/advisor.md's `model: fable` fallback). Anthropic's
 * native server-side advisor (settings.advisorModel) is one global value with
 * no per-caller override and is not a hook-visible tool call, so it cannot be
 * escalated here; agent prompts steer Opus-tier callers away from it.
 *
 * Caller identity (measured 2026-09-02): a PreToolUse payload inside a subagent
 * carries `agent_id` / `agent_type`; a main-loop payload carries neither.
 * `transcript_path` always points at the MAIN transcript, so it can never
 * identify a subagent. The caller's MODEL is not in the payload at all, which
 * is why SubagentStart writes a per-session agent_id -> model registry.
 *
 * Caller MODEL (measured 2026-09-02): the real SubagentStart payload carries
 * `subagent_config: null`, so the registry alone resolves nothing and every
 * subagent used to fall through to 'unknown-caller' and be allowed. Claude Code
 * writes the truth to disk instead, under the session dir (= transcript_path
 * with the trailing ".jsonl" removed):
 *   <session_dir>/subagents/agent-<agent_id>.meta.json  {"model":"sonnet","spawnDepth":1,...}
 *   <session_dir>/subagents/agent-<agent_id>.jsonl      the subagent's own transcript
 * callerModelFor() walks registry -> subagent_config -> meta.json -> subagent
 * transcript -> agent-file frontmatter, and back-fills whatever it finds into
 * the registry so later calls are cheap. Resolution is lazy (done in decide()),
 * because meta.json may not exist yet when SubagentStart fires.
 *
 * Runs alongside the operator's own ~/.claude/hooks/agent-model-guard.cjs,
 * which already denies Agent calls with no explicit model and caps Fable
 * spawns per session. Neither rule is re-implemented here.
 *
 * Disable for a session: CAPABILITY_GRAPH_GUARD=off.
 * Report: node capability-graph-guard.cjs --report
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sessionModel, newestAssistantModel } = require('./fable-delegate-guard.cjs');

const RANKS = [[/fable/i, 3], [/opus/i, 2], [/sonnet/i, 1], [/haiku/i, 0]];
const ADVISOR_PER_AGENT = 2;
const ADVISOR_PER_SESSION = 3;
const MAX_STATE_AGE_MS = 24 * 60 * 60 * 1000;

const REASON_TEXT = '[capability-graph-guard] Capability graph: Fable -> Opus/Sonnet/Haiku; Opus -> Sonnet/Haiku; Sonnet -> Haiku; Haiku -> nobody. Delegation only flows downward; peers are not edges. The one upward edge is consultation: spawn subagent_type "advisor" (read-only guidance, ownership stays with you), at most 2 per agent and 3 per session; the guard picks its model, one rung above yours (Sonnet -> Opus, Opus -> Fable).';

function rankOf(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  for (const [re, rank] of RANKS) if (re.test(model)) return rank;
  return null;
}

const NAMES = { 3: 'Fable', 2: 'Opus', 1: 'Sonnet', 0: 'Haiku' };
const ALIASES = { 3: 'fable', 2: 'opus', 1: 'sonnet', 0: 'haiku' };

// The advisor's model: one rung above the caller, capped at Fable. An
// unresolvable caller gets Fable, the safe (never-a-peer) default.
function advisorModelFor(callerRank) {
  if (callerRank === null || callerRank === undefined) return ALIASES[3];
  return ALIASES[Math.min(callerRank + 1, 3)];
}

// --- paths / state ------------------------------------------------------------

function homeOf(opts) {
  return opts.home || os.homedir();
}
function stateDirOf(opts) {
  return opts.stateDir || path.join(homeOf(opts), '.agnostic', 'capability-graph-guard');
}
function graphDirOf(opts) {
  return path.join(stateDirOf(opts), 'graph');
}
function logPathOf(opts) {
  return opts.logPath || path.join(homeOf(opts), '.agnostic', 'capability-graph-guard.jsonl');
}
function nowIso(opts) {
  return new Date(opts.now || Date.now()).toISOString();
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) {
    return fallback;
  }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (_) {}
}

function prune(dir, opts) {
  try {
    const cutoff = (opts.now || Date.now()) - MAX_STATE_AGE_MS;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) {}
    }
  } catch (_) {}
}

function registryFile(sessionId, opts) {
  return path.join(graphDirOf(opts), `${sessionId || 'no-session'}.json`);
}
function advisorFile(sessionId, opts) {
  return path.join(graphDirOf(opts), `${sessionId || 'no-session'}.advisors.json`);
}

// SubagentStart opens the registry entry for an agent_id. Its payload usually
// does NOT carry the model (subagent_config is null in the real event), so the
// model is resolved by callerModelFor and may still be null here — decide()
// resolves again, lazily, once the sidecar files exist.
function recordSubagent(payload = {}, opts = {}) {
  const agentId = payload.agent_id;
  if (!agentId) return null;
  const cfg = payload.subagent_config || {};
  const file = registryFile(payload.session_id, opts);
  const reg = readJson(file, {});
  reg[agentId] = {
    model: null,
    agent_type: cfg.agent_type || payload.agent_type || null,
    ts: nowIso(opts)
  };
  writeJson(file, reg);
  callerModelFor(payload, opts); // back-fills model / spawn_depth when findable
  prune(graphDirOf(opts), opts);
  return readJson(file, {})[agentId] || null;
}

// --- callee model resolution ---------------------------------------------------

function frontmatterModel(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const m = fm[1].match(/^model\s*:\s*(.+)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') || null : null;
  } catch (_) {
    return null;
  }
}

function calleeModel(toolInput = {}, opts = {}) {
  if (toolInput.model) return String(toolInput.model);
  const type = toolInput.subagent_type;
  if (!type || /[\\/]/.test(type)) return null;
  const file = `${type}.md`;
  for (const base of [homeOf(opts), opts.cwd].filter(Boolean)) {
    const m = frontmatterModel(path.join(base, '.claude', 'agents', file));
    if (m) return m;
  }
  return null;
}

// --- caller model resolution ---------------------------------------------------

// The session dir Claude Code keeps a subagent's sidecar files in: the main
// transcript path with the trailing ".jsonl" removed.
function sessionDirOf(payload = {}, opts = {}) {
  if (opts.sessionDir) return opts.sessionDir;
  const tp = payload.transcript_path;
  if (typeof tp !== 'string' || !tp.trim()) return null;
  return tp.replace(/\.jsonl$/i, '');
}

// Resolves a subagent caller's model: registry -> subagent_config -> sidecar
// meta.json -> the subagent's own transcript -> agent-file frontmatter -> null.
// Anything found is written back into the registry entry.
function callerModelFor(payload = {}, opts = {}) {
  const agentId = payload.agent_id;
  if (!agentId) return { model: null, source: 'none', spawn_depth: null };

  const file = registryFile(payload.session_id, opts);
  const reg = readJson(file, {});
  const entry = reg[agentId] || {};
  let depth = typeof entry.spawn_depth === 'number' ? entry.spawn_depth : null;
  if (entry.model) return { model: entry.model, source: 'registry', spawn_depth: depth };

  let model = null;
  let source = 'none';

  const cfg = payload.subagent_config;
  if (cfg && cfg.model) {
    model = String(cfg.model);
    source = 'subagent_config';
  }

  const dir = sessionDirOf(payload, opts);
  if (dir) {
    const base = path.join(dir, 'subagents', `agent-${agentId}`);
    const meta = readJson(`${base}.meta.json`, null);
    if (meta) {
      if (typeof meta.spawnDepth === 'number') depth = meta.spawnDepth;
      if (!model && meta.model) {
        model = String(meta.model);
        source = 'meta';
      }
    }
    if (!model) {
      try {
        const m = newestAssistantModel(`${base}.jsonl`);
        if (m) {
          model = m;
          source = 'subagent-transcript';
        }
      } catch (_) {}
    }
  }

  if (!model) {
    const type = payload.agent_type || entry.agent_type;
    const m = calleeModel({ subagent_type: type }, { ...opts, cwd: payload.cwd });
    if (m) {
      model = m;
      source = 'agent-file';
    }
  }

  if (model || (depth !== null && depth !== entry.spawn_depth)) {
    reg[agentId] = {
      ...entry,
      model: model || entry.model || null,
      agent_type: entry.agent_type || payload.agent_type || null,
      ts: entry.ts || nowIso(opts),
      ...(model ? { model_source: source } : {}),
      ...(depth === null ? {} : { spawn_depth: depth })
    };
    writeJson(file, reg);
  }

  return { model, source: model ? source : 'none', spawn_depth: depth };
}

// --- logging -------------------------------------------------------------------

function logEvent(entry, opts = {}) {
  try {
    const file = logPathOf(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

// --- decision -------------------------------------------------------------------

function decide(payload = {}, opts = {}) {
  const env = opts.env || process.env;
  if (String(env.CAPABILITY_GRAPH_GUARD || '').toLowerCase() === 'off') {
    return { action: 'allow', kind: 'disabled', reason: '' };
  }

  const tool = payload.tool_name || '';
  if (tool !== 'Agent' && tool !== 'Task' && tool !== 'Workflow') {
    return { action: 'allow', kind: 'not-applicable', reason: '' };
  }

  const input = payload.tool_input || {};
  const type = String(input.subagent_type || '');
  const sid = payload.session_id || null;
  const agentId = payload.agent_id || null;

  // Caller model: resolved (and cached) per agent_id for a subagent, session
  // model for the main loop.
  let callerModel = null;
  let callerSource = 'session';
  let callerDepth = null;
  if (agentId) {
    const resolved = callerModelFor(payload, opts);
    callerModel = resolved.model;
    callerSource = resolved.source;
    callerDepth = resolved.spawn_depth;
  } else {
    callerModel = sessionModel(payload, { home: homeOf(opts), model: opts.sessionModelOverride });
  }
  const callerRank = rankOf(callerModel);

  const calleeM = tool === 'Workflow' ? null : calleeModel(input, { ...opts, cwd: payload.cwd });

  const record = (kind, calleeModelOverride) => logEvent({
    ts: nowIso(opts),
    session_id: sid,
    kind,
    caller: {
      agent_id: agentId || 'main',
      model: callerModel,
      source: callerSource,
      ...(callerDepth === null ? {} : { spawn_depth: callerDepth })
    },
    callee: { subagent_type: type || null, model: calleeModelOverride === undefined ? calleeM : calleeModelOverride },
    tool_name: tool
  }, opts);

  const deny = (kind, sentence) => {
    record(kind);
    return { action: 'deny', kind, reason: `${REASON_TEXT} ${sentence}` };
  };

  if (callerRank === null) {
    // Fail open on an unrecognised caller, but leave one trace per agent so a
    // registry that never fills up is visible instead of silent.
    if (agentId) {
      const file = registryFile(sid, opts);
      const reg = readJson(file, {});
      if (!reg[`unknown:${agentId}`]) {
        reg[`unknown:${agentId}`] = { ts: nowIso(opts) };
        writeJson(file, reg);
        record('unknown-caller');
      }
    }
    return { action: 'allow', kind: 'unknown-caller', reason: '' };
  }

  const callerName = NAMES[callerRank];

  if (tool === 'Workflow') {
    if (!agentId) return { action: 'allow', kind: 'main-workflow', reason: '' };
    if (callerRank <= 1) {
      return deny('workflow-rank', `Blocked: a ${callerName} subagent may not run a Workflow; only an Opus subagent (or the main loop) may fan work out that way. Delegate downward with the Agent tool instead.`);
    }
    let script = input.script || '';
    if (!script && input.scriptPath) {
      try { script = fs.readFileSync(input.scriptPath, 'utf8'); } catch (_) { script = ''; }
    }
    if (!script) return { action: 'allow', kind: 'workflow-named', reason: '' };
    const re = /\bmodel\s*:\s*['"`]([a-z0-9._-]+)/gi;
    let m;
    while ((m = re.exec(script)) !== null) {
      const r = rankOf(m[1]);
      if (r !== null && r >= callerRank) {
        return deny('workflow-upward', `Blocked: this Workflow script names model "${m[1]}", at or above the calling ${callerName} agent's own rank; every agent() inside it must be strictly weaker than its caller.`);
      }
    }
    return { action: 'allow', kind: 'workflow-downward', reason: '' };
  }

  // --- Agent / Task ---
  if (type.toLowerCase() === 'advisor') {
    if (callerRank === 0) {
      return deny('advisor-haiku', 'Blocked: a Haiku agent consults nobody. Return the open question to whoever spawned you and let them decide.');
    }
    const file = advisorFile(sid, opts);
    const state = readJson(file, { total: 0, byCaller: {} });
    const key = agentId || 'main';
    const used = state.byCaller[key] || 0;
    if (used >= ADVISOR_PER_AGENT) {
      return deny('advisor-cap', `Blocked: this agent has already used its ${ADVISOR_PER_AGENT} advisor consultations. The answer has to come from your own reasoning or from a downward delegation.`);
    }
    if ((state.total || 0) >= ADVISOR_PER_SESSION) {
      return deny('advisor-cap', `Blocked: this session has already used its ${ADVISOR_PER_SESSION} advisor consultations. The answer has to come from your own reasoning or from a downward delegation.`);
    }
    state.total = (state.total || 0) + 1;
    state.byCaller[key] = used + 1;
    writeJson(file, state);
    const model = advisorModelFor(callerRank);
    record('advisor', model);
    return { action: 'allow', kind: 'advisor', model, reason: `${NAMES[rankOf(model)]} advisor for a ${callerName} caller; ${used + 1} of ${ADVISOR_PER_AGENT} for this agent, ${state.total} of ${ADVISOR_PER_SESSION} for the session` };
  }

  // A fork inherits the parent model, so it is always a peer edge.
  if (type.toLowerCase() === 'fork') {
    if (agentId) {
      return deny('upward-or-peer', `Blocked: a fork inherits the calling ${callerName} agent's own model, which is a peer edge, not a delegation. Spawn a weaker model, or consult subagent_type "advisor".`);
    }
    return { action: 'allow', kind: 'fork-main', reason: '' };
  }

  const calleeRank = rankOf(calleeM);
  if (calleeRank === null) return { action: 'allow', kind: 'unknown-callee', reason: '' };
  if (callerRank === 0) {
    return deny('haiku-leaf', `Blocked: Haiku spawns nobody. This ${callerName} agent is a leaf; do the work in this agent or report back to your caller.`);
  }
  if (calleeRank < callerRank) return { action: 'allow', kind: 'downward', reason: '' };
  return deny('upward-or-peer', `Blocked: a ${callerName} caller requested ${NAMES[calleeRank]} (${type || 'agent'}, model "${calleeM}"), which is ${calleeRank === callerRank ? 'a peer, not a downward edge' : 'upward'}. Delegate to a weaker model, or consult subagent_type "advisor" for guidance you keep ownership of.`);
}

// --- entry point ------------------------------------------------------------------

// Returns the text to write to stdout ('' = nothing to say).
function main(payload = {}, opts = {}) {
  const event = payload.hook_event_name || (payload.tool_name ? 'PreToolUse' : '');

  if (event === 'SubagentStart') {
    recordSubagent(payload, opts);
    return '';
  }
  if (event === 'SubagentStop') return '';
  if (event !== 'PreToolUse') return '';

  const verdict = decide(payload, opts);
  if (verdict.kind === 'advisor' && verdict.model) {
    // Allow + updatedInput: the escalated model replaces whatever the caller
    // passed, so the advisor is never the caller's peer.
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `[capability-graph-guard] ${verdict.reason}`,
        updatedInput: { ...(payload.tool_input || {}), model: verdict.model }
      }
    });
  }
  if (verdict.action !== 'deny') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason
    }
  });
}

function report(opts = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(logPathOf(opts), 'utf8').trim().split('\n').filter(Boolean);
  } catch (_) {}
  const days = {};
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    const day = String(e.ts || '').slice(0, 10);
    const bucket = days[day] || (days[day] = {});
    bucket[e.kind] = (bucket[e.kind] || 0) + 1;
  }
  console.log(`capability-graph-guard: ${lines.length} events logged`);
  for (const d of Object.keys(days).sort()) {
    const kinds = Object.keys(days[d]).sort().map(k => `${k}=${days[d][k]}`).join('  ');
    console.log(`  ${d}  ${kinds}`);
  }
}

if (require.main === module) {
  if (process.argv.includes('--report')) {
    report();
    process.exit(0);
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('end', () => {
    try {
      const out = main(buffer.trim() ? JSON.parse(buffer) : {});
      if (out) process.stdout.write(out);
    } catch (err) {
      // Fail open: never block a session on a guard bug, but leave a trace.
      logEvent({ ts: new Date().toISOString(), kind: 'error', detail: String(err && err.message).slice(0, 160) });
    }
    process.exit(0);
  });
}

module.exports = { rankOf, calleeModel, callerModelFor, decide, recordSubagent, main, REASON_TEXT };
