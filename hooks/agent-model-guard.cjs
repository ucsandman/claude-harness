#!/usr/bin/env node
// Global guard: enforce the model hierarchy on subagent spawns.
// Fable = CEO/orchestrator (the main loop). A few Fable subagents are fine —
// e.g. 1-2 judges or a synthesizer — but never a fleet: subagents inherit the
// parent model by default, and on 2026-06-12 one unrouted workflow spawned 110
// Fable agents and exhausted a full 5-hour usage window.
//
// Rules:
// - Agent/Task: must set an explicit model. model:"fable" is allowed up to
//   FABLE_CAP spawns per session (counted in a state file next to this hook).
//   "fork" subagents inherit Fable, so they count against the same cap.
// - Workflow: every agent() call needs an inline model:. Fable models are
//   allowed on at most FABLE_CAP call sites, and never inside a fan-out
//   construct (parallel/pipeline/.map/.flatMap/.forEach/Array.from/for/while)
//   where one call site can multiply into many agents.
// Override the cap with env AGENT_GUARD_FABLE_CAP.

const fs = require("fs");
const path = require("path");

const FABLE_CAP = Math.max(0, parseInt(process.env.AGENT_GUARD_FABLE_CAP || "3", 10) || 3);
const STATE_FILE = path.join(__dirname, ".fable-spawn-counts.json");

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = data.tool_name || "";
const ti = data.tool_input || {};
const sessionId = String(data.session_id || "unknown");

const HIERARCHY =
  'Model hierarchy (global rule): Fable is the CEO/orchestrator (the main loop). A few Fable subagents are allowed for judge/synthesis roles — at most ' +
  FABLE_CAP +
  ' per session, never a fleet or fan-out. Delegate the bulk to model:"opus" (VP — owns large tasks, instructs Sonnet/Haiku workers in its prompt), model:"sonnet" (manager — mid-size implementation/review/exploration), or model:"haiku" (level-1 worker — searches, mechanical edits, simple checks).';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// --- per-session Fable spawn counter -----------------------------------------

function readCounts() {
  try {
    const c = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

function fableSpawnsUsed() {
  const entry = readCounts()[sessionId];
  return entry && typeof entry.count === "number" ? entry.count : 0;
}

function bumpFableSpawns() {
  const counts = readCounts();
  const now = Date.now();
  for (const k of Object.keys(counts)) {
    if (now - (counts[k].ts || 0) > 24 * 3600 * 1000) delete counts[k]; // prune stale sessions
  }
  counts[sessionId] = { count: ((counts[sessionId] || {}).count || 0) + 1, ts: now };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(counts));
  } catch {}
}

function gateFableSpawn(kind) {
  const used = fableSpawnsUsed();
  if (used >= FABLE_CAP) {
    deny(
      "BLOCKED: this session already spawned " +
        used +
        " Fable subagents (cap " +
        FABLE_CAP +
        "); " +
        kind +
        " would exceed it. " +
        HIERARCHY +
        " Use opus/sonnet/haiku for the remaining agents, or raise AGENT_GUARD_FABLE_CAP if the user explicitly approved more."
    );
  }
  bumpFableSpawns();
  process.exit(0);
}

// --- script scanning helpers --------------------------------------------------

// Scan from the open delimiter at openIdx to its matching close, skipping
// string literals and comments so delimiters inside them don't break the
// balance. Returns the span text including both delimiters, or null when the
// scan can't find the close.
function matchedSpan(script, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < script.length; i++) {
    const c = script[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < script.length && script[i] !== c) {
        if (script[i] === "\\") i++;
        i++;
      }
      if (i >= script.length) return null;
      continue;
    }
    if (c === "/" && script[i + 1] === "/") {
      while (i < script.length && script[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && script[i + 1] === "*") {
      i += 2;
      while (i < script.length && !(script[i] === "*" && script[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return script.slice(openIdx, i + 1);
    }
  }
  return null;
}

function callSpan(script, openIdx) {
  return matchedSpan(script, openIdx, "(", ")");
}

// Same-length copy of the script with the contents of string literals and
// comments blanked to spaces (newlines kept so line-based heuristics still
// work). Regex scans for call sites / keywords run on the masked text so
// prose inside prompt strings (e.g. "Any agent (Claude ...)" or "model:")
// can't register as code; paren balancing and value reads use the original.
// Template literals are masked whole, including ${} interpolations, matching
// how matchedSpan skips them.
function maskLiterals(script) {
  const out = script.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < script.length && script[i] !== c) {
        blank(i);
        if (script[i] === "\\" && i + 1 < script.length) {
          i++;
          blank(i);
        }
        i++;
      }
      continue;
    }
    if (c === "/" && script[i + 1] === "/") {
      while (i < script.length && script[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }
    if (c === "/" && script[i + 1] === "*") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < script.length && !(script[i] === "*" && script[i + 1] === "/")) {
        blank(i);
        i++;
      }
      if (i < script.length) blank(i);
      if (i + 1 < script.length) blank(i + 1);
      i++;
      continue;
    }
  }
  return out.join("");
}

const FABLE_MODEL_RE = /\bmodel\s*:\s*['"`][^'"`]*fable/i;

// A model: key found in the masked span is real code; its value lives in a
// string literal, so read it back from the original span at the same offset.
function spanHasFableModel(span, maskedSpan) {
  const re = /\bmodel\s*:\s*/g;
  let m;
  while ((m = re.exec(maskedSpan))) {
    if (/^['"`][^'"`]*fable/i.test(span.slice(m.index + m[0].length))) return true;
  }
  return false;
}

// Per-agent()-call inspection: index of each call site, whether its own
// argument span has an inline model:, and whether that model is fable.
// Call sites and model: keys are detected on the masked script; spans are
// balanced on the original. Returns null when any call's parens can't be
// matched (caller falls back to conservative whole-script heuristics rather
// than guessing).
function agentCalls(script, masked) {
  const re = /\bagent\s*\(/g;
  const calls = [];
  let m;
  while ((m = re.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    const span = callSpan(script, openIdx);
    if (span === null) return null;
    const maskedSpan = masked.slice(openIdx, openIdx + span.length);
    calls.push({
      index: m.index,
      hasModel: /\bmodel\s*:/.test(maskedSpan),
      isFable: spanHasFableModel(span, maskedSpan),
    });
  }
  return calls;
}

// [start, end) ranges of fan-out constructs where a single agent() call site
// can multiply into many agents. Heuristic: unparseable spans conservatively
// extend to end-of-script; brace-less single-statement loop bodies extend to
// end-of-line.
function fanoutRanges(script, masked) {
  const ranges = [];
  let m;
  const callRe = /(\bparallel|\bpipeline|\bArray\.from|\.map|\.flatMap|\.forEach)\s*\(/g;
  while ((m = callRe.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    const span = callSpan(script, openIdx);
    ranges.push([m.index, span ? openIdx + span.length : script.length]);
  }
  const loopRe = /\b(?:for|while)\s*\(/g;
  while ((m = loopRe.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    const head = callSpan(script, openIdx);
    if (!head) {
      ranges.push([m.index, script.length]);
      continue;
    }
    const afterHead = openIdx + head.length;
    const braceIdx = masked.indexOf("{", afterHead);
    if (braceIdx === -1 || masked.slice(afterHead, braceIdx).trim() !== "") {
      const nl = masked.indexOf("\n", afterHead);
      ranges.push([m.index, nl === -1 ? script.length : nl]);
      continue;
    }
    const body = matchedSpan(script, braceIdx, "{", "}");
    ranges.push([m.index, body ? braceIdx + body.length : script.length]);
  }
  return ranges;
}

// --- Agent / Task -------------------------------------------------------------

// Subagent types whose definition frontmatter pins a non-Fable model; they are
// safe to spawn without an explicit model parameter (the pin wins).
const PINNED_SAFE_SUBAGENTS = new Set([
  "codex:codex-rescue", // model: sonnet — thin Bash forwarder to the Codex runtime
]);

if (toolName === "Agent" || toolName === "Task") {
  if (PINNED_SAFE_SUBAGENTS.has(String(ti.subagent_type || "").toLowerCase())) {
    process.exit(0);
  }
  if (String(ti.subagent_type || "").toLowerCase() === "fork") {
    // fork subagents always inherit the parent model (Fable 5) and ignore the
    // model parameter — treat as a Fable spawn against the session cap.
    gateFableSpawn("this fork subagent (forks inherit Fable)");
  }
  const model = String(ti.model || "").toLowerCase();
  if (!model) {
    deny(
      "BLOCKED: Agent call has no explicit model — it would inherit the session model (Fable 5) uncounted. " +
        HIERARCHY +
        ' Re-issue this exact Agent call with the model parameter set (model:"fable" is allowed within the per-session cap).'
    );
  }
  if (model.includes("fable")) {
    gateFableSpawn("this Fable subagent");
  }
  process.exit(0);
}

// --- Workflow -----------------------------------------------------------------

if (toolName === "Workflow") {
  let script = ti.script || "";
  if (!script && ti.scriptPath) {
    try {
      script = fs.readFileSync(ti.scriptPath, "utf8");
    } catch {
      process.exit(0); // unreadable path — let the Workflow tool surface the real error
    }
  }
  if (!script) process.exit(0); // named workflow — nothing to inspect

  const masked = maskLiterals(script);
  const calls = agentCalls(script, masked);

  if (calls === null) {
    // Span scanner couldn't parse the script — fall back to whole-script
    // heuristics: require a model: somewhere and refuse fable outright, since
    // per-site fan-out analysis is impossible.
    if (/\bagent\s*\(/.test(masked) && !/\bmodel\s*:/.test(masked)) {
      deny(
        "BLOCKED: this Workflow script has agent() calls but no model: option anywhere — those agents would inherit Fable 5 (exactly what burned a full 5h usage window with 110 Fable agents on 2026-06-12). " +
          HIERARCHY +
          " Give every agent() call its own inline model:, then re-invoke."
      );
    }
    if (FABLE_MODEL_RE.test(script)) {
      deny(
        "BLOCKED: this Workflow script uses a fable model but the guard could not parse its agent() calls to verify the fan-out rules. " +
          HIERARCHY +
          " Simplify the script (balanced parens, inline model: per agent() call) or use opus/sonnet/haiku, then re-invoke."
      );
    }
    process.exit(0);
  }

  const missing = calls.filter((c) => !c.hasModel).length;
  if (missing > 0) {
    deny(
      "BLOCKED: this Workflow script has agent() call(s) without an inline model: option (" +
        missing +
        " of them) — those agents would inherit Fable 5 (exactly what burned a full 5h usage window with 110 Fable agents on 2026-06-12). " +
        HIERARCHY +
        " Every agent() call needs its own inline model: (a shared opts variable doesn't count for this guard), then re-invoke."
    );
  }

  const fableCalls = calls.filter((c) => c.isFable);
  if (fableCalls.length > 0) {
    if (fableCalls.length > FABLE_CAP) {
      deny(
        "BLOCKED: this Workflow script has " +
          fableCalls.length +
          " agent() call sites with a fable model (cap " +
          FABLE_CAP +
          "). " +
          HIERARCHY +
          " Keep at most " +
          FABLE_CAP +
          " Fable call sites (judges/synthesizers) and route the rest to opus/sonnet/haiku, then re-invoke."
      );
    }
    const ranges = fanoutRanges(script, masked);
    const fannedOut = fableCalls.some((c) => ranges.some(([s, e]) => c.index >= s && c.index < e));
    if (fannedOut) {
      deny(
        "BLOCKED: this Workflow script spawns a fable-model agent() inside a fan-out construct (parallel/pipeline/map/loop) — one call site there can multiply into a fleet of Fable agents (the 2026-06-12 incident spawned 110 and burned a full 5h usage window). " +
          HIERARCHY +
          " Fable agent() calls must be standalone top-level awaits (e.g. a single judge or final synthesizer); use opus/sonnet/haiku inside fan-outs, then re-invoke."
      );
    }
  }
  process.exit(0);
}

process.exit(0);
