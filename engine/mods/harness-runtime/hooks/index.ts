// harness-runtime — the ONE adapter between Anthropic's early-access function-hook API and Wes's products.
// Everything product-facing consumes `runtime.emit` events and `$.runtime.*`; nothing else touches the raw API.
// If the API changes, this file changes.

const RING_MAX = 500;
const state = {
  seq: 0, ring: [], pending: [], sessionId: "", logDir: "", backend: "stub", apiKey: "",
  supports: null, started: 0, lastUsage: null, subagents: {}, opened: {},
};
function now() { return Date.now(); }
function short(v, n) { let s; try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); } s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function safe(v, n) { try { const s = JSON.stringify(v); if (s === undefined) return null; return s.length > n ? JSON.parse(JSON.stringify(short(s, n))) : JSON.parse(s); } catch { return String(v); } }

// ---- core of the noun (runs as the bottom of every `runtime.*` chain; no `$` here) ----
function emitCore(event) {
  const ev = { ...event, seq: ++state.seq, t: event.t || now() };
  state.ring.push(ev); if (state.ring.length > RING_MAX) state.ring.shift();
  state.pending.push(ev);
  return { seq: ev.seq };
}
function snapshotCore(args) {
  const a = args || {}; let rows = state.ring;
  if (a.kind) rows = rows.filter(r => r.kind === a.kind);
  const limit = a.limit || 50; return rows.slice(-limit);
}
function supportsCore() { return state.supports || declaredSupports(); }
function declaredSupports() {
  const s = {
    toolInterception: true, toolResultMutation: true, runtimeEvents: true, subagentEvents: true,
    uiInjection: false, dynamicPermissions: true, contextSignals: true, usageSignals: true,
    middleware: true, runtimeMemory: true, checkpointing: "file-level", classicEvents: false,
    systemPromptRewrite: false, semanticJudgment: state.backend, provenance: {},
  };
  for (const k of Object.keys(s)) if (k !== "provenance") s.provenance[k] = "declared";
  return s;
}
// deterministic judge (the backend a runtime must always have)
function stubJudge(req) {
  const st = req.state || {}; const calls = st.recent_tool_calls_oldest_first || []; const turnOpen = !!(st.session && st.session.turn_open);
  const inFlight = calls.some(c => c.in_flight) || (Array.isArray(st.subagents_running) && st.subagents_running.length > 0);
  const reads = calls.filter(c => c.tool === "Read").map(c => c.args); const reread = reads.length !== new Set(reads).size;
  const denied = calls.filter(c => c.denied || c.error).length;
  const answers = {};
  for (const [k, q] of Object.entries(req.questions || {})) {
    if (q.type === "noul") {
      let p = 0.5;
      if (/in progress|mid-flight/i.test(q.instructions)) p = (turnOpen || inFlight) ? 0.9 : 0.1;
      else if (/clean boundary|hand(ing)? .*over/i.test(q.instructions)) p = (turnOpen || inFlight) ? 0.1 : 0.9;
      else if (/thrash/i.test(q.instructions)) p = denied >= 2 ? 0.9 : 0.1;
      else if (/re-?read/i.test(q.instructions)) p = reread ? 0.9 : 0.1;
      else if (/human|dialog|approval/i.test(q.instructions)) p = calls.slice(-1).some(c => c.tool === "AskUserQuestion") ? 0.9 : 0.1;
      answers[k] = { type: "noul", p_yes: p };
    } else if (q.type === "choice") {
      const opts = Object.keys(q.criteria || {}); const pick = opts.includes("idle") && !turnOpen ? "idle" : (opts.includes("stuck") && reread ? "stuck" : opts[0]);
      const probs = {}; for (const o of opts) probs[o] = o === pick ? 0.7 : 0.3 / Math.max(1, opts.length - 1);
      answers[k] = { type: "choice", choice: pick, confidence: 0.4, probabilities: probs };
    } else {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 2; const sc = turnOpen ? (n - 1) * 0.66 : 0.3;
      answers[k] = { type: "score", score: Math.round(sc * 100) / 100, confidence: 0.4, probabilities: {} };
    }
  }
  return { backend: "stub", latencyMs: 0, answers };
}

// ---- judge backends that need `$` (run from this plugin's own hook on `runtime.judge`) ----
async function modelJudge($, req) {
  const t0 = now();
  const spec = {}; for (const [k, q] of Object.entries(req.questions)) spec[k] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
  const prompt = "STATE:\n" + JSON.stringify(req.state) + "\n\nQUESTIONS:\n" + JSON.stringify(spec);
  const system = "You are a calibrated judgment engine. Evaluate STATE against every QUESTION independently. Answer ONLY one JSON object mapping each question id to: noul -> {\"p_yes\": 0..1}; choice -> {\"choice\": option, \"probabilities\": {option: p}}; score -> {\"score\": number, \"probabilities\": {\"0\": p, ...}}. No prose, no code fences.";
  const text = await $.model.complete({ model: "haiku", prompt, system, maxTokens: 600 });
  const m = /\{[\s\S]*\}/.exec(text || ""); const raw = m ? JSON.parse(m[0]) : {};
  const answers = {};
  for (const [k, q] of Object.entries(req.questions)) {
    const a = raw[k] || {};
    if (q.type === "noul") answers[k] = { type: "noul", p_yes: Number(a.p_yes ?? 0.5) };
    else if (q.type === "choice") { const probs = a.probabilities || {}; const ch = a.choice || Object.keys(probs).sort((x, y) => probs[y] - probs[x])[0] || null; answers[k] = { type: "choice", choice: ch, confidence: probs[ch] || 0, probabilities: probs }; }
    else answers[k] = { type: "score", score: Number(a.score ?? 0), confidence: 0, probabilities: a.probabilities || {} };
  }
  return { backend: "model", latencyMs: now() - t0, answers };
}
async function jevJudge($, req) {
  const t0 = now();
  const body = JSON.stringify({ state: req.state, model: "jev-latest", questions: req.questions });
  const res = await $.http.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "Authorization": "Bearer " + state.apiKey, "Content-Type": "application/json" }, body });
  if (!res.ok) throw new Error("typesafe " + res.status + ": " + short(res.text, 200));
  const j = JSON.parse(res.text); const answers = {};
  for (const [k, a] of Object.entries(j.answers || {})) {
    if (a.type === "noul") answers[k] = { type: "noul", p_yes: a.noul };
    else if (a.type === "choice") answers[k] = { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
    else answers[k] = { type: "score", score: a.score, confidence: a.confidence, probabilities: a.probabilities };
  }
  return { backend: "jev", latencyMs: now() - t0, answers, usage: j.usage };
}

// ---- helpers that take `$` (top-level functions, per the validator) ----
async function resolveLogDir($) {
  if (state.logDir) return;
  let home = "";
  try { home = (await $.env.get("CLAUDE_CONFIG_DIR")) || ""; } catch (err) { home = ""; }
  if (!home) {
    let base = "";
    try { base = (await $.env.get("USERPROFILE")) || ""; } catch (err) { base = ""; }
    if (!base) { try { base = (await $.env.get("HOME")) || ""; } catch (err) { base = ""; } }
    home = base ? base + "/.claude" : "";
  }
  if (home) state.logDir = String(home).replace(/\\/g, "/").replace(/\/$/, "") + "/mods/state/events/";
}
async function flushLog($) {
  if (!state.pending.length || !state.sessionId) return;
  await resolveLogDir($);
  if (!state.logDir) return;
  const rows = state.pending.splice(0); const path = state.logDir + state.sessionId + ".jsonl";
  let prev = ""; try { if (await $.fs.exists(path)) prev = await $.fs.read(path); } catch (err) { prev = ""; }
  try { await $.fs.write(path, prev + rows.map(r => JSON.stringify(r)).join("\n") + "\n"); } catch (err) { state.pending.unshift(...rows); }
}
async function probeSupports($, e) {
  const s = declaredSupports(); const prov = s.provenance;
  try { const pol = await $.settings.read({ source: "policy" }); s.classicEvents = Object.keys(pol || {}).length === 0; s.systemPromptRewrite = s.classicEvents; prov.classicEvents = "probed"; prov.systemPromptRewrite = "probed"; } catch (err) {}
  try { const u = await $.session.usage(); s.usageSignals = !!u; s.contextSignals = typeof u.context.window === "number"; prov.usageSignals = "probed"; prov.contextSignals = "probed"; state.lastUsage = u; } catch (err) { s.usageSignals = false; s.contextSignals = false; }
  s.uiInjection = e.surface === "terminal"; prov.uiInjection = "probed";
  try { await $.store.set("harness-runtime.probe", now()); s.runtimeMemory = true; prov.runtimeMemory = "probed"; } catch (err) { s.runtimeMemory = false; }
  s.semanticJudgment = state.backend; prov.semanticJudgment = "probed";
  state.supports = s;
}
function fileTargets(e) {
  const t = e.tool; if (t === "Read" || t === "Write" || t === "Edit") return [String(e.file_path || "")];
  if (t === "NotebookEdit") return [String(e.notebook_path || "")];
  if (t === "Grep" || t === "Glob") return [String(e.path || e.pattern || "")];
  return [];
}

export const register = (on, options) => {
  state.backend = typeof options.judgeBackend === "string" ? options.judgeBackend : "stub";
  state.apiKey = typeof options.typesafeApiKey === "string" ? options.typesafeApiKey : "";
  // eventLogDir from userConfig, else <Claude home>/mods/state/events/ resolved through $.env on the first flush
  // (the hooks worker has no Node globals, so nothing here may read the environment at load time).
  state.logDir = typeof options.eventLogDir === "string" && options.eventLogDir ? options.eventLogDir : "";

  // The noun: added to `$` for every plugin loaded after this one.
  on("engine.create", async ($, e, next) => {
    const built = await next(e);
    return { ...built, runtime: { emit: emitCore, supports: supportsCore, judge: stubJudge, snapshot: snapshotCore } };
  });

  // Our own hook on our own noun event: answers `judge` with a backend that needs `$`.
  on("runtime.judge", async ($, e, next) => {
    const backend = e.backend || state.backend;
    if (backend === "model") { try { return { value: await modelJudge($, e) }; } catch (err) { return next(e); } }
    if (backend === "jev" && state.apiKey) { try { return { value: await jevJudge($, e) }; } catch (err) { return next(e); } }
    return next(e);
  });

  on("session.start", async ($, e, next) => {
    state.sessionId = await $.session.id(); state.started = now();
    await probeSupports($, e);
    await $.runtime.emit({ kind: "SessionStarted", source: "session.start", data: { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, model: await $.session.model(), supports: state.supports } });
    $.clock.every(2000, () => { void flushLog($); });
    await flushLog($);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    await $.runtime.emit({ kind: "PromptSubmitted", source: "prompt.submit", data: { origin: e.origin ? e.origin.kind : "unknown", chars: e.text.length, preview: short(e.text, 120), turnId: e.turnId || null } });
    return next(e);
  });
  on("turn.start", async ($, e, next) => { await $.runtime.emit({ kind: "TurnStarted", source: "turn.start", data: { turnId: e.turnId, chars: e.text.length } }); return next(e); });

  on("turn.step", async function* ($, e, next) {
    const t0 = now(); let chunks = 0;
    const stream = next(e);
    for await (const c of stream) { chunks++; yield c; }
    const r = await stream.result;
    await $.runtime.emit({ kind: "ModelStep", source: "turn.step", agentId: e.agentId, data: { turnId: e.turnId, index: e.index, model: e.model, effort: e.effort || null, messageCount: e.messageCount, chunks, ms: now() - t0, stopReason: r.stopReason, toolUses: r.toolUses.map(t => t.name), usage: r.usage } });
    if (!e.agentId) await $.runtime.emit({ kind: "ContextChanged", source: "turn.step", data: { messageCount: e.messageCount, contextTokens: r.usage ? (r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens) : null } });
    return r;
  });

  on("tool.check", async ($, e, next) => {
    const r = await next(e);
    await $.runtime.emit({ kind: "PermissionRequested", source: "tool.check", data: { tool: e.tool, input: safe(e.input, 400), decision: r.decision, reason: r.reason || null, rule: r.rule || null, byPlugin: next.trace.some(t => t.tier !== "core" && t.outcome === "returned") } });
    return r;
  });

  on("tool.call", async ($, e, next) => {
    const t0 = now(); const { tool, tool_use_id, agentId, ...args } = e;
    await $.runtime.emit({ kind: "ToolRequested", source: "tool.call", agentId, data: { tool, tool_use_id, args: safe(args, 600) } });
    for (const p of fileTargets(e)) if (p) await $.runtime.emit({ kind: tool === "Read" || tool === "Grep" || tool === "Glob" ? "FileObserved" : "FileModified", source: "tool.call", agentId, data: { tool, path: p, tool_use_id } });
    let r;
    try { r = await next(e); } catch (err) { await $.runtime.emit({ kind: "ErrorOccurred", source: "tool.call", agentId, data: { tool, tool_use_id, error: short(String(err), 300) } }); throw err; }
    const ms = now() - t0;
    await $.runtime.emit({ kind: "ToolCompleted", source: "tool.call", agentId, data: { tool, tool_use_id, ms, denied: r.deny ? short(r.deny, 200) : null, isError: !!r.isError, textChars: (r.text || "").length, preview: short(r.text || r.deny || "", 160), trace: next.trace.map(t => ({ plugin: t.plugin, tier: t.tier, outcome: t.outcome, ms: Math.round(t.ms * 10) / 10 })) } });
    if (r.isError) await $.runtime.emit({ kind: "ErrorOccurred", source: "tool.call", agentId, data: { tool, tool_use_id, error: short(r.text || "", 300) } });
    return r;
  });

  on("agent.spawn", async ($, e, next) => {
    const r = await next(e);
    if (r.agentId) state.subagents[r.agentId] = { type: e.subagentType, model: r.model, t0: now() };
    await $.runtime.emit({ kind: "SubagentStarted", source: "agent.spawn", agentId: e.parentAgentId, data: { childAgentId: r.agentId || null, type: e.subagentType, model: r.model || null, requestedModel: e.model || null, parentModel: e.parentModel, background: e.background, promptChars: e.prompt.length, denied: r.deny || null } });
    return r;
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId) {
      const s = state.subagents[e.agentId] || {};
      await $.runtime.emit({ kind: "SubagentCompleted", source: "turn.complete", agentId: e.agentId, data: { type: s.type || null, model: s.model || (e.usage ? e.usage.model : null), reason: e.reason, durationMs: e.durationMs, usage: e.usage || null, answerChars: e.answer.length } });
    } else {
      await $.runtime.emit({ kind: "TurnCompleted", source: "turn.complete", data: { turnId: e.turnId, reason: e.reason, durationMs: e.durationMs, usage: e.usage || null, answerChars: e.answer.length } });
      try { const u = await $.session.usage(); state.lastUsage = u; await $.runtime.emit({ kind: "UsageChanged", source: "session.usage", data: u }); } catch (err) {}
      await flushLog($);
    }
    return next(e);
  });
};
