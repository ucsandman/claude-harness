#!/usr/bin/env node
/**
 * agy-adapter.cjs — run an unmodified Claude Code hook under Antigravity CLI (agy).
 *
 * agy speaks a different hook dialect than Claude Code / Codex:
 *   - payload keys are camelCase protojson: conversationId, workspacePaths, toolCall.{name,args}
 *   - tool names are agy's own: run_command, write_to_file, replace_file_content, view_file
 *   - tool args are PascalCase: CommandLine, TargetFile, CodeContent, ...
 *   - PreToolUse decisions are allow | deny | ask | force_ask   (Claude: allow | deny | ask)
 *   - only 5 events exist: PreToolUse PostToolUse PreInvocation PostInvocation Stop
 *   - context injection is PreInvocation -> injectSteps[].ephemeralMessage
 *     (Claude does it with hookSpecificOutput.additionalContext)
 *
 * So instead of maintaining a second copy of every guard, this translates in both
 * directions and shells out to the real guard in ~/.claude/hooks.
 *
 * Usage in ~/.gemini/config/hooks.json:
 *   node ~/.claude/hooks/adapters/agy-adapter.cjs PreToolUse node ~/.claude/hooks/secret-guard.cjs
 *   node ~/.claude/hooks/adapters/agy-adapter.cjs PreInvocation python ~/.claude/hooks/context-nudge.py
 *
 * Chain several guards in ONE hook entry by separating them with `++`:
 *   ... PreToolUse node a.cjs ++ node b.cjs ++ rtk hook claude
 * Chaining is not a convenience — it is required. agy merges the results of
 * multiple hooks registered for the same event and the LAST result's `reason`
 * wins, so a guard that denies with a reason gets its reason blanked by any
 * later no-opinion hook. Verified live 2026-08-17: the deny survived, the
 * explanation did not. One entry per event = one result = the reason survives.
 * First deny/ask in the chain wins and short-circuits.
 *
 * Fail-open by design: if the guard crashes or the payload is unparseable we emit
 * `{}` (no opinion) rather than deny, so a broken adapter can never wedge agy.
 * Docs: ~/.claude/docs/harness-parity.md
 */

const { spawnSync } = require('child_process');

const AGY_EVENT = process.argv[2];

// Split the remaining argv into one or more commands on the `++` separator.
const CHAIN = process.argv
  .slice(3)
  .reduce((acc, a) => (a === '++' ? (acc.push([]), acc) : (acc[acc.length - 1].push(a), acc)), [[]])
  .filter((c) => c.length);

// agy tool name -> the Claude tool name the guards already match on.
const TOOL_MAP = {
  run_command: 'Bash',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  view_file: 'Read',
  grep_search: 'Grep',
  list_dir: 'Glob',
  invoke_subagent: 'Agent',
  define_subagent: 'Agent',
  manage_subagents: 'Agent',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
};

// agy PascalCase arg -> the Claude tool_input key the guards read.
const ARG_MAP = {
  CommandLine: 'command',
  Cwd: 'cwd',
  TargetFile: 'file_path',
  AbsolutePath: 'file_path',
  CodeContent: 'content',
  TargetContent: 'old_string',
  ReplacementContent: 'new_string',
  Query: 'pattern',
  SearchDirectory: 'path',
};

function noOpinion() {
  process.stdout.write('{}');
  process.exit(0);
}

function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const raw = readStdin();
let agy;
try {
  agy = JSON.parse(raw || '{}');
} catch {
  noOpinion();
}

// ---- agy payload -> Claude payload -------------------------------------------
const toolCall = agy.toolCall || {};
const agyArgs = toolCall.args || {};
const toolInput = {};
for (const [k, v] of Object.entries(agyArgs)) {
  if (k === 'toolAction' || k === 'toolSummary') continue;
  toolInput[ARG_MAP[k] || k] = v;
}

const claudePayload = {
  session_id: agy.conversationId || 'agy',
  transcript_path: agy.transcriptPath || null,
  cwd: (agy.workspacePaths && agy.workspacePaths[0]) || process.cwd(),
  hook_event_name: AGY_EVENT,
  model: agy.modelName || 'agy',
  permission_mode: 'default',
  tool_name: TOOL_MAP[toolCall.name] || toolCall.name || '',
  tool_input: toolInput,
  // Stop-event fields the Claude guards may look at
  stop_hook_active: false,
  // agy extras kept under a namespaced key so guards can opt in
  agy: { stepIdx: agy.stepIdx, invocationNum: agy.invocationNum, terminationReason: agy.terminationReason, error: agy.error },
};

// agy reasons are ASCII-folded and capped. The guards' teaching text is the
// payload; the typography is not (and Wes's own style rule bans em dashes).
function normalizeReason(s) {
  return String(s || '')
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[…]/g, '...')
    .replace(/[→]/g, '->')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

// ---- run the chain -----------------------------------------------------------
// Each guard gets the same translated payload. The first one to deny or ask wins
// and stops the chain; rewrites from non-deciding guards accumulate.
if (!CHAIN.length) noOpinion();

let decision = null;
let reason = '';
let context = '';
let updatedInput = null;

for (const cmd of CHAIN) {
  if (cmd[0] === 'rtk' && claudePayload.tool_name !== 'Bash') continue;
  let res;
  try {
    res = spawnSync(cmd[0], cmd.slice(1), {
      input: JSON.stringify(claudePayload),
      encoding: 'utf8',
      timeout: 25_000, // agy's own default hook timeout is 30s
      windowsHide: true,
    });
  } catch {
    continue; // a broken guard must never wedge agy
  }
  if (!res || res.error) continue;

  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();

  let inner = null;
  if (stdout.startsWith('{')) {
    try {
      inner = JSON.parse(stdout);
    } catch {
      inner = null;
    }
  }

  // Claude guards signal a block two ways: exit code 2 (+ reason on stderr), or
  // hookSpecificOutput.permissionDecision === "deny".
  const hso = (inner && inner.hookSpecificOutput) || {};
  let d = hso.permissionDecision || inner?.permissionDecision || inner?.decision || null;
  if (d === 'block') d = 'deny';
  if (res.status === 2 && !d && stderr) d = 'deny';

  const r = normalizeReason(
    hso.permissionDecisionReason || inner?.permissionDecisionReason || inner?.reason || stderr || ''
  );
  const c = hso.additionalContext || inner?.additionalContext || (inner ? '' : stdout) || '';
  if (c && !context) context = String(c);

  const u = hso.updatedInput || inner?.updatedInput;
  if (u && Object.keys(u).length) updatedInput = { ...(updatedInput || {}), ...u };

  if (d === 'deny' || d === 'ask' || d === 'force_ask') {
    decision = d;
    reason = r;
    break; // first decisive guard wins
  }
}

// Claude's "ask" maps straight across; agy also has force_ask, which nothing
// in the Claude suite emits, so it is never produced here.
const AGY_DECISIONS = new Set(['allow', 'deny', 'ask', 'force_ask']);

const out = {};

if (AGY_EVENT === 'PreToolUse') {
  out.decision = 'allow';
  // Only speak up when the guard actually decided something. An unconditional
  // "allow" here would silently bypass agy's own permission prompts.
  if (decision === 'deny' || decision === 'ask' || decision === 'force_ask') {
    out.decision = decision;
    if (reason) out.reason = reason;
  } else if (updatedInput) {
    // A rewriting hook (rtk) returns updatedInput and no permissionDecision at
    // all, so this must not be gated on decision === "allow".
    // Claude keys -> agy keys, for the shallow top-level merge agy performs.
    const rev = Object.fromEntries(Object.entries(ARG_MAP).map(([a, c]) => [c, a]));
    out.overwrite = Object.fromEntries(
      Object.entries(updatedInput).map(([k, v]) => [rev[k] || k, v])
    );
    if (AGY_DECISIONS.has('allow')) out.decision = 'allow';
  }
} else if (AGY_EVENT === 'Stop') {
  // Claude: {"decision":"block","reason":...} keeps the agent working.
  // agy:    {"decision":"continue","reason":...} does the same.
  if (decision === 'deny') {
    out.decision = 'continue';
    if (reason) out.reason = reason;
  }
} else if (AGY_EVENT === 'PreInvocation' || AGY_EVENT === 'PostInvocation') {
  // Claude injects context as hookSpecificOutput.additionalContext or plain
  // stdout text; agy takes injectSteps[].ephemeralMessage.
  if (context) out.injectSteps = [{ ephemeralMessage: String(context).slice(0, 20_000) }];
  if (decision === 'deny' && AGY_EVENT === 'PostInvocation') out.terminationBehavior = 'force_continue';
}
// PostToolUse: agy expects {} — nothing to translate.

process.stdout.write(JSON.stringify(out));



