// canary.mjs — what a healthy Mod layer looks like, so silence cannot read as health. Pure.
//
// The Mod fills a status object during the session (probes at session.start, counts as events flow,
// the middleware order from the first tool.call trace). `judge()` turns it into ok/failures. The
// classic canary leg (~/.claude/mods/canary.cjs, run by guard-canary.ps1 and the first-prompt
// liveness hook) reads the written status and applies the same judgement from outside the plugin.

// The order is read from the ADAPTER's next.trace (ToolCompleted.data.trace): it lists the user plugins
// beneath the adapter, so seeing harness-mods there proves harness-runtime is outermost. The adapter
// never appears in its own trace.
export const EXPECTED_ORDER = ["harness-mods"];
export const EXPECTED_SUPPORTS = ["toolInterception", "toolResultMutation", "runtimeEvents", "subagentEvents", "dynamicPermissions", "usageSignals", "contextSignals", "middleware", "runtimeMemory"];
export const RUNTIME_PIN = { claudeVersion: "2.1.319", dtsSha256Prefix: "ab7a8a2d45f5d8d8" };

export function newStatus() {
  return {
    runtimeNoun: false,        // $.runtime reachable
    supports: null,            // probed capability set
    usageProbe: false,         // $.session.usage() returned a context window
    storeProbe: false,         // $.store round-trip worked
    busEvents: 0,              // runtime.emit events seen
    toolCalls: 0,              // raw tool.call events seen
    order: null,               // plugin order from next.trace on the first tool.call
    hookErrors: 0,             // .catch handlers hit
    enforcementReached: { toolCall: false, agentSpawn: false },
    version: null,
    lastError: null,
  };
}

/** Grade a status. `modes` are the effective guard modes; `phase` is "start" (probes only) or "live". */
export function judge(status, modes, phase = "live") {
  const failures = [];
  if (!status.runtimeNoun) failures.push("adapter-noun-missing: $.runtime is not reachable (harness-runtime did not load or loaded after harness-mods)");
  if (!status.supports) failures.push("capability-probe-missing");
  else for (const k of EXPECTED_SUPPORTS) if (status.supports[k] !== true) failures.push("capability-changed: " + k + "=" + JSON.stringify(status.supports[k]));
  if (!status.usageProbe) failures.push("session-usage-unavailable");
  if (!status.storeProbe) failures.push("store-unavailable");
  if (status.hookErrors > 0) failures.push("hook-failures: " + status.hookErrors + (status.lastError ? " (" + status.lastError + ")" : ""));
  if (phase === "live") {
    if (status.toolCalls > 0 && status.busEvents === 0) failures.push("events-not-flowing: tool calls seen but no runtime.emit events");
    if (status.order && !sameOrder(status.order, EXPECTED_ORDER)) failures.push("middleware-order: adapter trace shows [" + status.order.join(" > ") + "], expected [" + EXPECTED_ORDER.join(" > ") + "] beneath harness-runtime (is harness-runtime loaded first?)");
    if (status.toolCalls > 0 && !status.enforcementReached.toolCall) failures.push("enforcement-unreachable: tool.call never reached harness-mods");
  }
  const enforcing = Object.keys(modes || {}).filter((g) => modes[g] === "mod");
  if (enforcing.length && failures.length) failures.push("mod-mode-with-failures: " + enforcing.join(",") + " are in mod mode while the layer is unhealthy; classic fallback must stay armed");
  return { ok: failures.length === 0, failures, enforcing };
}

function sameOrder(actual, expected) {
  const a = actual.filter((p) => expected.includes(p));
  return a.length === expected.length && a.every((p, i) => p === expected[i]);
}
