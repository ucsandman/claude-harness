// harness-mods — the harness's Function Hooks layer (hook glue only; policy lives in ./lib/*.mjs).
//
//   Claude Code → harness-runtime (adapter, loaded first) → runtime.emit bus + $.runtime.* → THIS
//
// Raw events hooked here only where the Mod must intercept (agent.spawn, tool.call, prompt.submit);
// everything observational comes off the bus. Every guard runs in the mode mods-config.json gives it
// (classic | shadow_mod | mod); the classic hook for the same decision stands down only when the
// heartbeat this file writes says the Mod armed that guard for this session (see lib/modes.mjs).
// A silent failure cannot read as healthy: lib/canary.mjs grades the status this file records, the
// heartbeat is re-written every main turn, and the classic canary leg reads it from outside.

import { parseConfig, allModes, GUARDS, GUARD_NOTES } from "./lib/modes.mjs";
import { explain, withContext, explainRoute } from "./lib/explain.mjs";
import { observation, mutations, targetFor } from "./lib/targets.mjs";
import { redactToolResult, summarize } from "./lib/redact.mjs";
import { decide, signatureOf, EXIT_TOOLS } from "./lib/routing.mjs";
import * as budget from "./lib/budget.mjs";
import { row as shadowRow, report as shadowReport } from "./lib/shadow.mjs";
import { summary as usageSummary } from "./lib/usage.mjs";
import { newStatus, judge, RUNTIME_PIN } from "./lib/canary.mjs";

const VERSION = "0.1.0";
// The installed Claude home (CLAUDE_CONFIG_DIR, else ~/.claude): runtime state, the mode config and the
// classic hooks' ledger all live there, whatever directory this plugin is loaded from. The hooks worker
// has no Node globals; the home is read through `$.env` on the first event and cached (2026-09-19, after
// a top-level environment read kept the whole module from loading).
let CLAUDE_HOME = "";
let STATE_DIR = "", CONFIG_PATH = "", CLASSIC_BUDGET_LOG = "";
async function resolveHome($) {
  if (CLAUDE_HOME) return;
  let home = "";
  try { home = (await $.env.get("CLAUDE_CONFIG_DIR")) || ""; } catch (err) { home = ""; }
  if (!home) {
    let base = "";
    try { base = (await $.env.get("USERPROFILE")) || ""; } catch (err) { base = ""; }
    if (!base) { try { base = (await $.env.get("HOME")) || ""; } catch (err) { base = ""; } }
    home = base ? base + "/.claude" : "";
  }
  if (!home) return; // no home known: every path stays empty and the file writes below fail quietly
  CLAUDE_HOME = String(home).replace(/\\/g, "/").replace(/\/$/, "");
  STATE_DIR = CLAUDE_HOME + "/mods/state/";
  CONFIG_PATH = CLAUDE_HOME + "/mods/mods-config.json";
  CLASSIC_BUDGET_LOG = CLAUDE_HOME + "/hooks/.subagent-budget-log.jsonl";
}
const STORE_KEY = "harness-mods.ledger";
const SERVE_AFTER = 3; // the Nth exact identical observation of an unchanged file is served from cache

const state = {
  sessionId: "", cfg: null, modes: {}, armed: {}, status: newStatus(), ledger: budget.newLedger(),
  usage: null, model: "",
  routes: {},            // tool_use_id -> route (for the Agent tool.call explanation)
  fableUsed: 0, denied: {},
  readCache: {},         // "tool|path|args" -> { result, chars, size, mtimeMs, n, firstAt }
  observed: {},          // path -> count of observations across mechanisms
  shadow: [],            // rows this session (mod side)
  redactions: 0, served: 0, savedChars: 0, calls: 0, lastRoute: null, lastLine: "",
  dirty: false, hbTs: 0,
};

// ---------------------------------------------------------------- helpers with `$` (top-level, per the validator)
async function readConfig($) { try { return parseConfig(await $.fs.read(CONFIG_PATH)); } catch (err) { return parseConfig(""); } }
// Per-session overrides (the same names hooks/lib/mods-mode.cjs honours): $.env.get takes literal names only.
async function readEnv($) {
  const env = {};
  try { env.HARNESS_MODS = await $.env.get("HARNESS_MODS"); } catch (err) {}
  try { env.HARNESS_MOD_ROUTING = await $.env.get("HARNESS_MOD_ROUTING"); } catch (err) {}
  try { env.HARNESS_MOD_SECRET_REDACTION = await $.env.get("HARNESS_MOD_SECRET_REDACTION"); } catch (err) {}
  try { env.HARNESS_MOD_SUBAGENT_ACCOUNTING = await $.env.get("HARNESS_MOD_SUBAGENT_ACCOUNTING"); } catch (err) {}
  try { env.HARNESS_MOD_READ_CACHE = await $.env.get("HARNESS_MOD_READ_CACHE"); } catch (err) {}
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}
async function appendLine($, path, obj) {
  let prev = "";
  try { if (await $.fs.exists(path)) prev = await $.fs.read(path); } catch (err) { prev = ""; }
  try { await $.fs.write(path, prev + JSON.stringify(obj) + "\n"); } catch (err) {}
}
// /clear rotates the session id without a second session.start (observed 2026-09-18, session
// b3802eef: heartbeat kept landing under the pre-clear id 962fcf8c, the classic witness and the
// statusline looked up the new id and reported "did not load"). Re-read the id before every write.
async function syncSessionId($) {
  let sid = ""; try { sid = String((await $.session.id()) || ""); } catch (err) { return false; }
  if (!sid || sid === state.sessionId) return false;
  log($, "session id rotated " + state.sessionId.slice(0, 8) + " -> " + sid.slice(0, 8) + " (/clear); heartbeat re-keyed");
  state.sessionId = sid; return true;
}

async function writeHeartbeat($, extra) {
  await syncSessionId($);
  const verdict = judge(state.status, state.modes, state.status.toolCalls > 0 ? "live" : "start");
  const row = {
    sessionId: state.sessionId, ts: Date.now(), plugin: "harness-mods", version: VERSION, pin: RUNTIME_PIN,
    runtime: state.status.runtimeNoun, modes: state.modes, armed: state.armed, canary: verdict,
    status: state.status, usage: state.usage ? { context: state.usage.context, rateLimits: state.usage.rateLimits, cost: state.usage.cost } : null,
    counts: { calls: state.calls, redactions: state.redactions, served: state.served, savedChars: state.savedChars, spawns: state.ledger.totals.spawns, rewrites: state.ledger.totals.rewrites, denies: state.ledger.totals.denies, shadowRows: state.shadow.length },
    ...extra,
  };
  state.hbTs = row.ts;
  try { await $.fs.write(STATE_DIR + "sessions/" + state.sessionId + ".json", JSON.stringify(row)); } catch (err) {}
  try { await $.fs.write(STATE_DIR + "canary-status.json", JSON.stringify({ sessionId: state.sessionId, ts: row.ts, ok: verdict.ok, failures: verdict.failures, enforcing: verdict.enforcing, modes: state.modes, version: VERSION, pin: RUNTIME_PIN })); } catch (err) {}
}
async function flushShadow($) {
  if (!state.dirty) return;
  state.dirty = false;
  try { await $.fs.write(STATE_DIR + "shadow/" + state.sessionId + ".mod.jsonl", state.shadow.map((r) => JSON.stringify(r)).join("\n") + (state.shadow.length ? "\n" : "")); } catch (err) {}
}
async function probeAll($, e) {
  try { state.status.supports = await $.runtime.supports(); state.status.runtimeNoun = !!state.status.supports; } catch (err) { state.status.runtimeNoun = false; }
  try { const u = await $.session.usage(); state.usage = u; state.status.usageProbe = !!(u && u.context && typeof u.context.window === "number"); } catch (err) { state.status.usageProbe = false; }
  try { const stored = await $.store.get(STORE_KEY); if (stored && stored.priors) state.ledger.priors = stored.priors; await $.store.set(STORE_KEY + ".probe", Date.now()); state.status.storeProbe = true; } catch (err) { state.status.storeProbe = false; }
  try { state.model = await $.session.model(); } catch (err) { state.model = ""; }
  state.status.version = RUNTIME_PIN.claudeVersion;
}
async function persistPriors($) { try { await $.store.set(STORE_KEY, { priors: state.ledger.priors, updatedAt: Date.now(), sessionId: state.sessionId }); } catch (err) {} }
async function refreshUsage($) { try { state.usage = await $.session.usage(); return state.usage; } catch (err) { return null; } }
async function statUnchanged($, path, entry) {
  try { const st = await $.fs.stat(path); return !!st && st.kind === "file" && st.size === entry.size && st.mtimeMs === entry.mtimeMs; } catch (err) { return false; }
}
async function statOf($, path) { try { const st = await $.fs.stat(path); return st && st.kind === "file" ? { size: st.size, mtimeMs: st.mtimeMs } : null; } catch (err) { return null; } }
function log($, line) { state.lastLine = line; $.ui.log("⟦mods⟧ " + line); }

function mode(guard) { return state.modes[guard] || "classic"; }
function enforcing(guard) { return mode(guard) === "mod" && state.armed[guard] === true; }
function shadow(fields) {
  state.shadow.push(shadowRow({ session: state.sessionId, side: "mod", ...fields }));
  if (state.shadow.length > 5000) state.shadow.shift();
  state.dirty = true;
}
function armedFor(modes, st) {
  return {
    routing: modes.routing === "mod",
    secretRedaction: modes.secretRedaction === "mod",
    subagentAccounting: modes.subagentAccounting === "mod" && st.runtimeNoun,
    readCache: modes.readCache === "mod",
  };
}
function bandText() {
  const m = state.modes;
  const short = { classic: "c", shadow_mod: "s", mod: "M" };
  const abbr = { routing: "rou", secretRedaction: "sec", subagentAccounting: "sub", readCache: "rea" };
  const guards = Object.keys(GUARDS).map((g) => (abbr[g] || g.slice(0, 3)) + ":" + (short[m[g]] || "?") + (m[g] === "mod" && !state.armed[g] ? "!" : "")).join(" ");
  const c = state.status.runtimeNoun ? (judge(state.status, state.modes, state.status.toolCalls > 0 ? "live" : "start").ok ? "✓" : "✗") : "✗";
  const t = budget.totals(state.ledger);
  return "MODS " + c + " " + guards + " · " + usageSummary(state.usage) + " · spawns " + state.ledger.totals.spawns + " rw " + state.ledger.totals.rewrites + " · redact " + state.redactions + " · served " + state.served + " · live " + budget.liveAgents(state.ledger).length + " · reserved " + Math.round(t.reserved / 1000) + "k/charged " + Math.round(t.charged / 1000) + "k";
}

export const register = (on, options) => {
  // ---------------------------------------------------------------- session
  on("session.start", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    state.sessionId = await $.session.id();
    state.cfg = await readConfig($);
    state.modes = allModes(state.cfg, await readEnv($));
    await probeAll($, e);
    state.armed = armedFor(state.modes, state.status);
    await $.command.register({ name: "mods", description: "harness-mods: modes, canary, shadow comparison, ledger, rollback (status | shadow | ledger | rollback)", argumentHint: "[status|shadow|ledger|rollback]", immediate: true });
    await writeHeartbeat($, { surface: e.surface, isInteractive: e.isInteractive });
    const v = judge(state.status, state.modes, "start");
    log($, "armed v" + VERSION + " · runtime=" + state.status.runtimeNoun + " · modes " + Object.keys(state.modes).map((g) => g + "=" + state.modes[g]).join(" ") + " · canary " + (v.ok ? "ok" : "FAIL " + v.failures.join("; ")));
    // No $.ui.status band and no AbovePrompt tree (removed 2026-09-18): the statusline already
    // shows the same modes, usage and cost from the heartbeat, and three copies of one line is noise.
    // The band lives on in /mods and in the heartbeat file.
    return next(e);
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "session.start"; return next(e); });

  // ---------------------------------------------------------------- the bus (observation only)
  on("runtime.emit", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    const r = await next(e);
    state.status.busEvents++;
    const d = e.data || {};
    if (e.kind === "ModelStep" && e.agentId) budget.step(state.ledger, e.agentId, d.usage, Date.now());
    else if (e.kind === "SubagentCompleted" && e.agentId) {
      const a = budget.settle(state.ledger, e.agentId, { usage: d.usage, durationMs: d.durationMs, reason: d.reason }, Date.now());
      if (a) {
        const nowIso = new Date().toISOString();
        const crow = budget.calibrationRow(state.sessionId, a, nowIso);
        await appendLine($, STATE_DIR + "subagents.jsonl", { ...crow, resolvedModel: a.resolvedModel || null, parentModel: a.parentModel || null, reasons: a.reasons || [] });
        if (mode("subagentAccounting") !== "classic") await appendLine($, CLASSIC_BUDGET_LOG, crow);
        await persistPriors($);
        shadow({ subsystem: "subagentAccounting", action: "settle " + a.type, key: a.agentId, mode: mode("subagentAccounting"), decision: "measured", requestedValue: a.declared, resolvedValue: a.measured, reasonCodes: [a.reservedFrom], enforced: false, actualOutcome: a.reason, note: "predictionError=" + a.predictionError + " reserveError=" + a.reserveError });
        log($, "settle " + String(a.agentId).slice(0, 8) + " " + a.type + " " + a.model + " calls=" + a.calls + " declared=" + (a.declared === null ? "n/a" : a.declared) + " reserved=" + a.reserved + " measured=" + a.measured + " overhead=" + (a.overhead || 0) + " · median(" + a.type + ")=" + a.learnedPrior + " overhead-median=" + a.learnedOverhead);
      }
    } else if (e.kind === "UsageChanged") {
      state.usage = d;
    } else if (e.kind === "ToolCompleted" && !state.status.order && Array.isArray(d.trace)) {
      state.status.order = d.trace.filter((t) => t.tier === "user").map((t) => t.plugin);
    }
    return r;
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "runtime.emit"; return next(e); });

  // ---------------------------------------------------------------- routing (the one raw agent.spawn hook)
  on("agent.spawn", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    const t0 = Date.now();
    const type = e.subagentType || "general-purpose";
    const sig = signatureOf(state.sessionId, type, e.prompt, e.model);
    const prior = budget.priorFor(state.ledger, type);
    const d = decide(e, { fableUsed: state.fableUsed, fableCap: 3, prior: prior.tokens, priorSource: prior.source, isWarm: budget.isWarm(state.ledger, t0), deniedOnce: !!state.denied[sig] });
    const m = mode("routing");
    const enforce = enforcing("routing");
    const route = { ms: t0, type, parent: e.parentModel, requested: e.model, model: d.model, action: d.action, reasons: d.reasons, est: d.budget ? d.budget.est : null, agentId: null, resolvedModel: null, enforced: enforce, tool_use_id: e.tool_use_id };
    state.ledger.totals.spawns++;
    state.status.enforcementReached.agentSpawn = true;

    if (d.action === "deny" && enforce) {
      state.ledger.totals.denies++;
      state.denied[sig] = 1;
      state.lastRoute = route;
      shadow({ subsystem: "routing", action: "Agent " + type, key: sig, mode: m, decision: "deny", requestedValue: e.model || null, resolvedValue: null, reasonCodes: d.reasons, enforced: true, latencyMs: Date.now() - t0 });
      log($, "DENY " + type + " parent=" + e.parentModel + " [" + d.reasons.join(", ") + "]");
      await flushShadow($);
      return { deny: d.reason };
    }
    const wouldRewrite = d.action === "rewrite";
    const sent = enforce && wouldRewrite ? { ...e, model: d.model } : e;
    if (enforce && wouldRewrite) state.ledger.totals.rewrites++; else state.ledger.totals.passes++;
    if (d.graph && d.graph.fableCounted) state.fableUsed++;
    const r = await next(sent);
    const agentId = r && r.agentId ? r.agentId : null;
    route.agentId = agentId; route.resolvedModel = r ? r.model : null;
    state.lastRoute = route;
    if (e.tool_use_id) state.routes[e.tool_use_id] = route;
    if (agentId) budget.open(state.ledger, { agentId, type, model: r.model, resolvedModel: r.model, requested: e.model, rewritten: enforce && wouldRewrite, reasons: d.reasons, est: route.est, declared: d.budget && d.budget.est ? prior.tokens + d.budget.est.calls * 2000 + d.budget.est.files * 2000 : null, reserved: prior.total, reservedFrom: prior.totalSource, parentModel: e.parentModel, description: String(e.description || "").slice(0, 60) }, Date.now());
    shadow({ subsystem: "routing", action: "Agent " + type, key: sig, mode: m, decision: d.action === "deny" ? "deny" : wouldRewrite ? "rewrite" : "allow", requestedValue: e.model || null, resolvedValue: r ? r.model : null, reasonCodes: d.reasons, wouldRewrite, enforced: enforce, latencyMs: Date.now() - t0, actualOutcome: r && r.deny ? "denied-beneath: " + String(r.deny).slice(0, 80) : agentId ? "spawned" : "no-agent" });
    log($, (enforce ? (wouldRewrite ? "REWRITE " : d.action === "deny" ? "WOULD-DENY(anti-thrash) " : "PASS ") : "SHADOW(" + d.action + ") ") + type + " " + (e.model === undefined ? "inherit" : e.model) + " → " + (r ? r.model : "?") + " (parent " + e.parentModel + ") [" + d.reasons.join(", ") + "]" + (agentId ? " agent=" + String(agentId).slice(0, 8) + " reserve=" + prior.total + " overhead=" + prior.tokens : ""));
    await flushShadow($);
    return r;
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "agent.spawn"; return next(e); });

  // ---------------------------------------------------------------- tool.call (the one raw hook: exit exemption, read cache, redaction, explanations)
  on("tool.call", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    const t0 = Date.now();
    state.calls++; state.status.toolCalls++; state.status.enforcementReached.toolCall = true;
    const { tool, tool_use_id, agentId, ...input } = e;
    if (agentId) { const a = state.ledger.agents[agentId]; if (a) a.calls++; }
    if (EXIT_TOOLS.indexOf(tool) >= 0) return next(e); // an exit tool is never intercepted, cached or redacted

    // 1. mutations invalidate cached observations
    const muts = mutations(tool, input);
    if (muts.length) {
      for (const k of Object.keys(state.readCache)) { if (muts.indexOf("*") >= 0 || muts.indexOf(state.readCache[k].path) >= 0) delete state.readCache[k]; }
      for (const p of muts) if (p !== "*") state.observed[p] = 0;
      if (muts.indexOf("*") >= 0) state.observed = {};
    }

    // 2. the read cache: target-keyed detection, strict serving
    const obs = observation(tool, input);
    let cacheKey = null;
    if (obs) {
      state.observed[obs.path] = (state.observed[obs.path] || 0) + 1;
      const n = state.observed[obs.path];
      cacheKey = tool + "|" + obs.path + "|" + (tool === "Read" ? String(input.offset) + "|" + String(input.limit) : String(input.command || "").trim());
      const entry = state.readCache[cacheKey];
      if (n >= 2) shadow({ subsystem: "readCache", action: obs.via + " " + obs.path, key: obs.path + "#" + n, mode: mode("readCache"), decision: entry && n >= SERVE_AFTER && obs.exact ? "serve" : "repeat", requestedValue: obs.via, resolvedValue: n, reasonCodes: [entry ? "cached" : "not-cached", obs.exact ? "exact" : "inexact"], wouldRewrite: !!(entry && n >= SERVE_AFTER && obs.exact), enforced: enforcing("readCache") });
      if (entry && n >= SERVE_AFTER && obs.exact && enforcing("readCache") && (await statUnchanged($, obs.path, entry))) {
        entry.n++;
        state.served++; state.savedChars += entry.chars;
        const note = explain({ kind: "cache-serve", what: obs.via + " of " + obs.path + " (observation #" + n + ")", why: "identical call, file unchanged since observation #" + entry.firstAt + " (size+mtime verified)", actual: "this is the cached result of that earlier call, not a fresh read; saved ~" + Math.ceil(entry.chars / 4) + " tokens" });
        log($, "SERVED " + obs.via + " " + obs.path + " #" + n + " (~" + Math.ceil(entry.chars / 4) + " tok)");
        await flushShadow($);
        return withContext({ result: entry.result }, note);
      }
    }

    // 3. run it
    let r = await next(e);
    const latency = Date.now() - t0;

    // 4. redaction: detection becomes replacement
    const red = redactToolResult(r);
    if (red) {
      const m = mode("secretRedaction");
      const enforce = enforcing("secretRedaction");
      shadow({ subsystem: "secretRedaction", action: tool + " " + String(targetFor(tool, input) || ""), key: tool_use_id, mode: m, decision: enforce ? "redact" : "detect", resolvedValue: red.kinds.join(","), reasonCodes: red.kinds, wouldRewrite: true, enforced: enforce, latencyMs: latency, note: summarize(red.hits) });
      await appendLine($, STATE_DIR + "redactions.jsonl", { ts: new Date().toISOString(), session: state.sessionId, tool, tool_use_id, agentId: agentId || null, kinds: red.kinds, hits: red.hits.length, enforced: enforce });
      if (enforce) {
        state.redactions++;
        const note = explain({ kind: "redaction", what: red.hits.length + " secret shape(s) [" + summarize(red.hits) + "] replaced with <REDACTED:…> in the " + tool + " result", why: "a credential must never enter the transcript", actual: "the tool ran normally; only the secret values were masked. Do not try to reprint them; tell the user which credential it was so they can rotate it if it was real" });
        log($, "REDACTED " + summarize(red.hits) + " in " + tool + " result");
        $.ui.toast("harness-mods redacted " + summarize(red.hits) + " from a " + tool + " result");
        // A fresh answer: never spread `r` here, its `text`/`ref` still carry the raw value and the
        // adapter above logs `text` (seen 2026-09-16: the value reached the event log through `text`).
        r = withContext({ result: red.result, isError: r.isError === true ? true : undefined }, note);
      } else {
        log($, "SHADOW would redact " + summarize(red.hits) + " in " + tool + " result (classic watch alerts)");
      }
    }

    // 5. cache the first exact observation
    if (obs && obs.exact && cacheKey && !state.readCache[cacheKey] && r && !r.deny && !r.isError && r.result !== undefined) {
      const st = await statOf($, obs.path);
      if (st) { let chars = 0; try { chars = JSON.stringify(r.result).length; } catch (err) { chars = 0; } state.readCache[cacheKey] = { path: obs.path, result: r.result, chars, size: st.size, mtimeMs: st.mtimeMs, n: 1, firstAt: state.observed[obs.path] }; }
    }

    // 6. the Agent tool's result: explain a model rewrite to the parent (agent.spawn's result carries no context)
    if (tool === "Agent" && tool_use_id && state.routes[tool_use_id]) {
      const note = explainRoute(state.routes[tool_use_id]);
      if (note && state.routes[tool_use_id].enforced) r = withContext(r, note);
    }
    return r;
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "tool.call"; return next(e); });

  // ---------------------------------------------------------------- prompt.submit: session heartbeat
  on("prompt.submit", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    if (await syncSessionId($)) await writeHeartbeat($, {});
    return next(e);
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "prompt.submit"; return next(e); });

  // ---------------------------------------------------------------- turn.complete: heartbeat, usage, flush
  on("turn.complete", async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    if (!e.agentId) {
      await refreshUsage($);
      await flushShadow($);
      await writeHeartbeat($, {});
    }
    return next(e);
  }).catch(($, e, next) => { state.status.hookErrors++; state.status.lastError = "turn.complete"; return next(e); });

  // ---------------------------------------------------------------- /mods
  on("command.run", { command: "mods" }, async ($, e, next) => {
    await resolveHome($); // the validator wants $ handed only to top-level functions, so each hook resolves the home itself
    await flushShadow($);
    const arg = (e.args || "").trim().toLowerCase() || "status";
    const v = judge(state.status, state.modes, state.status.toolCalls > 0 ? "live" : "start");
    const head = "HARNESS MODS v" + VERSION + " · session " + state.sessionId + " · model " + state.model
      + "\n  canary: " + (v.ok ? "OK" : "FAIL") + (v.failures.length ? "\n    " + v.failures.join("\n    ") : "")
      + "\n  modes: " + Object.keys(state.modes).map((g) => g + "=" + state.modes[g] + (state.modes[g] === "mod" ? (state.armed[g] ? " (armed)" : " (NOT ARMED → classic enforcing)") : "")).join(", ")
      + "\n  runtime noun " + state.status.runtimeNoun + " · bus events " + state.status.busEvents + " · tool calls " + state.status.toolCalls + " · order " + (state.status.order ? state.status.order.join(" > ") : "n/a") + " · hook errors " + state.status.hookErrors
      + "\n  usage: " + usageSummary(state.usage)
      + "\n  band: " + bandText()
      + "\n  counts: spawns " + state.ledger.totals.spawns + " rewritten " + state.ledger.totals.rewrites + " denied " + state.ledger.totals.denies + " · redactions " + state.redactions + " · served " + state.served + " · shadow rows " + state.shadow.length;
    if (arg === "rollback") {
      return { text: head + "\n\nROLLBACK (any one of these; classic hooks are still installed and take over immediately):"
        + "\n  per guard, all sessions:  edit " + CONFIG_PATH + " → \"<guard>\": \"classic\""
        + "\n  per session:              HARNESS_MOD_ROUTING=classic (or HARNESS_MODS=off) in the environment"
        + "\n  whole layer:              claude plugin disable harness-mods@harness-mods   (and harness-runtime@harness-mods)"
        + "\n  the classic side yields only while sessions/<id>.json says the Mod armed the guard; delete that file and classic enforces." };
    }
    if (arg === "shadow") {
      const rep = shadowReport(state.shadow);
      return { text: head + "\n\nSHADOW (this session, mod side only; join with state/shadow/<id>.classic.jsonl for pairs)\n" + JSON.stringify(rep, null, 1).slice(0, 6000) };
    }
    if (arg === "ledger") {
      const rows = state.ledger.order.map((id) => state.ledger.agents[id]).map((a) => "  " + String(a.agentId).slice(0, 8) + "  " + String(a.type).padEnd(20) + String(a.model).padEnd(26) + " calls=" + a.calls + " declared=" + (a.declared === null ? "n/a" : a.declared) + " reserved=" + a.reserved + " (" + a.reservedFrom + ") " + (a.settled ? "measured=" + a.measured + " err=" + a.predictionError : "live tok=" + a.tokens));
      const priors = Object.keys(state.ledger.priors).map((t) => "  " + t.padEnd(22) + "n=" + state.ledger.priors[t].samples.length + " median=" + state.ledger.priors[t].median);
      return { text: head + "\n\nLEDGER\n" + (rows.join("\n") || "  none") + "\n\nPRIORS ($.store " + STORE_KEY + ")\n" + (priors.join("\n") || "  none yet") };
    }
    const notes = GUARD_NOTES.map(([g, note]) => "  " + g + " [" + mode(g) + "]: " + note).join("\n");
    return { text: head + "\n  last: " + state.lastLine + "\n  files: " + STATE_DIR + "{sessions/<id>.json, shadow/, subagents.jsonl, redactions.jsonl, canary-status.json}\n\nGUARDS\n" + notes };
  });

  // No ui.render AbovePrompt band (removed 2026-09-18): the statusline reads the heartbeat this file
  // writes and draws the modes once, below the prompt. Route decisions still reach the transcript
  // through log() and the /mods status output.
};
