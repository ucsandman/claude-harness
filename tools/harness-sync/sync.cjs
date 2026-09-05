#!/usr/bin/env node
/**
 * harness-sync — keep the Codex and Antigravity (agy) harnesses in step with the
 * Claude one, from a single source of truth.
 *
 *   node ~/.claude/tools/harness-sync/sync.cjs           # write everything
 *   node ~/.claude/tools/harness-sync/sync.cjs --check    # exit 1 if stale, write nothing
 *
 * What is generated for Codex (all from files the Claude harness already owns):
 *
 *   ~/.codex/AGENTS.md      <- ~/.claude/CLAUDE.md (+ its @imports) + SOUL.md
 *   ~/.codex/config.toml    <- hook definitions and [hooks.state] trust entries,
 *                              so Codex runs them without a manual /hooks review
 *   ~/.codex/agents/*.toml  <- ~/.claude/agents/*.md (custom subagents, model ladder mapped)
 *   ~/.codex/prompts/*.md   <- ~/.claude/commands/*.md (slash commands, /prompts:<name>)
 *   ~/.codex/skills/<name>  <- junctions into ~/.claude/skills (every skill Codex can run)
 *
 * agy still gets the rules file and the skill links; its hook dialect is handled by
 * ~/.gemini/config/hooks.json + hooks/adapters/agy-adapter.cjs, not by this file.
 *
 * Why generated: the Codex files were hand-written in June 2026 and never touched
 * again while CLAUDE.md kept growing; by 2026-08-17 Codex ran a three-month-old
 * agreement. Then on 2026-08-18 a third-party installer clobbered the hand-wired
 * ~/.codex/config.toml and nobody noticed until 2026-09-05, because a hand-wired file
 * has no source to be regenerated from. Everything here is derived, so `--check`
 * catches drift and a plain run repairs it.
 *
 * Human surface: node ~/.claude/tools/harness-sync/parity.cjs --open
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const SOURCE = path.join(HOME, '.claude', 'CLAUDE.md');
const SOUL = path.join(HOME, '.claude', 'SOUL.md');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CLAUDE_AGENTS = path.join(HOME, '.claude', 'agents');
const CLAUDE_COMMANDS = path.join(HOME, '.claude', 'commands');
const SKILL_SRC = path.join(HOME, '.claude', 'skills');
const CODEX_HOME = path.join(HOME, '.codex');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
const CHECK_ONLY = process.argv.includes('--check');

// Sections of CLAUDE.md that describe Claude-Code-only machinery. Dropping them
// beats shipping instructions that name tools the target harness does not have.
// Codex gets its own delegation section in the preamble instead.
const DROP_SECTIONS = ['Delegation and Model Routing'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJSON = (p) => {
  const raw = read(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
/** Write only when the content changed; in --check mode report instead. Returns true if stale. */
function emit(file, next, label, out) {
  const prev = read(file);
  if (prev === next) {
    out.push(`ok      ${label.padEnd(22)} ${file}`);
    return false;
  }
  if (CHECK_ONLY) {
    out.push(`STALE   ${label.padEnd(22)} ${file}`);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  out.push(`written ${label.padEnd(22)} ${file}  (${(Buffer.byteLength(next) / 1024).toFixed(1)} KB)`);
  return true;
}

/** Codex's model line, read from config.toml so the preamble never asserts a model from memory. */
function codexModel() {
  const t = read(CODEX_CONFIG) || '';
  const m = t.match(/^model\s*=\s*"([^"]+)"/m);
  const e = t.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
  return { model: m ? m[1] : '(unset)', effort: e ? e[1] : '(default)' };
}

// ---------------------------------------------------------------------------
// 1. Rules: CLAUDE.md (+ imports) + SOUL.md -> AGENTS.md / GEMINI.md
// ---------------------------------------------------------------------------

/** Strip a `## Heading` section (up to the next `## ` or EOF) from a markdown body. */
function dropSection(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return md;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

function rulesBody(source) {
  let body = source;
  // CLAUDE.md pulls the agreement in through Claude Code's `@<absolute path>`
  // import lines (agnostic-rules.md, compiled by agnostic-ai). Codex and agy do
  // not resolve those, so inline each absolute import here. Relative ones
  // (@RTK.md) are Claude-only and are stripped below. This file is the ONLY
  // writer of the Codex and agy agreements; agnostic-ai dropped its own targets
  // for them on 2026-09-03 after a forced sync there erased these preambles.
  body = body.replace(/^@((?:~|[A-Za-z]:)[^\s]+)\s*$/gm, (_line, p) => {
    const file = p.replace(/^~/, HOME);
    const approved = path.join(HOME, '.claude', 'agnostic-rules.md');
    if (path.resolve(file).toLowerCase() !== path.resolve(approved).toLowerCase()) throw new Error('Unapproved rules import');
    return fs.readFileSync(file, 'utf8').replace(/^# [^\n]*\n+(GENERATED FILE[^\n]*\n+)?/, '');
  });
  body = body.replace(/^[\s\S]*?(?=^# CLAUDE\.md)/m, '');
  body = body.replace(/^# CLAUDE\.md[^\n]*\n/m, '');
  for (const s of DROP_SECTIONS) body = dropSection(body, s);
  body = body
    .replace(/A project's own `CLAUDE\.md`/g, "A project's own agent instructions file")
    .replace(/@RTK\.md\s*$/m, '');
  return body.trim();
}

const CODEX_MODEL_LADDER = [
  // Claude rung -> Codex model + effort. Slugs come from ~/.codex/models_cache.json
  // (verified 2026-09-05); descriptions per the Codex subagents doc: gpt-5.6 for
  // demanding work, terra for balanced parallel workers, luna for fast narrow jobs.
  ['fable', 'gpt-6-astra', 'high'],
  ['opus', 'gpt-5.6-sol', 'high'],
  ['sonnet', 'gpt-5.6-terra', 'medium'],
  ['haiku', 'gpt-5.6-luna', 'low'],
];
const ladderFor = (claudeModel) => CODEX_MODEL_LADDER.find(([c]) => c === claudeModel) || CODEX_MODEL_LADDER[1];

function codexPreamble(ctx) {
  const { model, effort } = codexModel();
  const guards = ctx.guardNames.length ? ctx.guardNames.join(', ') : '(none generated)';
  const agents = ctx.agentNames.length ? ctx.agentNames.map((n) => `\`${n}\``).join(', ') : '(none)';
  const prompts = ctx.promptNames.length ? ctx.promptNames.map((n) => `\`/prompts:${n}\``).join(', ') : '(none)';
  return `# AGENTS.md — Wes's global working agreement (Codex CLI)

GENERATED FILE. Do not hand-edit: \`node ~/.claude/tools/harness-sync/sync.cjs\`
overwrites it. Edit the source instead: \`~/.claude/CLAUDE.md\`.

Everything below applies to Codex work. A repo's own AGENTS.md and my explicit
instructions override this file.

## How this harness differs from the Claude one

The safety layer is genuinely shared, not reimplemented: \`~/.codex/config.toml\` is
generated from \`~/.claude/settings.json\` and points at the same guard scripts in
\`~/.claude/hooks\` that Claude Code runs, so a fix lands in both at once. The global
git pre-commit hook (\`core.hooksPath\`) is machine-wide, so the secret scan and
doc gates already cover Codex commits.

Tool-name mapping when a rule below names a Claude tool:

| Rule says | In Codex |
|---|---|
| Bash / PowerShell | \`shell\` (\`Bash\` at the hook layer, \`shell_command\` in transcripts) |
| Edit / Write / MultiEdit | \`apply_patch\` |
| Read / Grep / Glob | \`shell\` (\`cat\`, \`rg\`, \`ls\`) |
| Agent / Task | \`spawn_agent\` with \`agent_type\` (see Delegation below) |
| Workflow | no equivalent; fan out with \`spawn_agent\` and collect with \`wait_agent\` |
| Artifact | no equivalent; write a file and say where it is |

Model: Codex runs \`${model}\` at \`${effort}\` per \`~/.codex/config.toml\` (read at
generation time, never asserted from memory). Verify a model id resolves before
writing it anywhere; a wrong id crashes the run.

Guards active in this harness (generated into config.toml, pre-trusted):
${guards}.
Contract for each, including the override markers: \`~/.claude/docs/harness-guards.md\`.

Not ported on purpose: agent-model-guard, capability-graph-guard and
fable-delegate-guard (they police Claude's model ladder), opus-handoff-inject,
guard-canary, session-count, output-secret-watch (Claude-only events or state),
context-nudge (reads Claude's statusline). Full table: \`~/.claude/docs/harness-parity.md\`.

## Memory (shared with Claude Code)

Identity is the SOUL.md section at the end of this file. The user profile and the
project map live in \`~/.agents/memory\` and are inlined above. Everything else is
injected at session start by \`~/.claude/hooks/codex-memory-inject.cjs\`: the project
map, the named facts under \`~/.agents/memory/{entities,notes}\`, and Claude Code's
per-project memory for the current directory
(\`~/.claude/projects/<cwd-slug>/memory/MEMORY.md\`, one file per fact). Save durable
facts into that same directory with the same frontmatter and index line; Claude Code
reads it too. Codex's native memories (\`~/.codex/memories\`) stay on as a recall layer,
never as the only home of a rule.

## Delegation in Codex

The Opus/Fable/Sonnet/Haiku ladder maps onto custom agents generated from
\`~/.claude/agents\` into \`~/.codex/agents/\`: ${agents}.
Spawn one with \`spawn_agent\` and \`agent_type: "<name>"\`; the agent file fixes the
model and effort, so do not pass \`model\` unless you mean to override it.

| Claude rung | Codex model | effort | use |
|---|---|---|---|
${CODEX_MODEL_LADDER.map(([c, m, e]) => `| ${c} | \`${m}\` | ${e} | ${c === 'fable' ? 'architecture, security review, judge/synthesis (max 3 per session)' : c === 'opus' ? 'large or risky implementation, root-cause hunts, final review' : c === 'sonnet' ? 'scoped implementation slices, tests, review legwork' : 'lookups, greps, inventories, mechanical edits'} |`).join('\n')}

Same economics as the Claude agreement: a spawn costs tens of thousands of tokens
before its first tool call, so anything under about ten tool calls or eighty
edited lines is cheaper in the main thread. Give children a clean context
(\`fork_turns: "none"\`), wait in bounded stretches with \`wait_agent\`, never poll.

## Slash commands

The Claude harness's custom commands are generated into \`~/.codex/prompts/\` and
invoked as ${prompts}. Skills are the same directories Claude uses, linked into
\`~/.codex/skills\` (plus the shared \`~/.agents/skills\`).
`;
}

const AGY_PREAMBLE = `# GEMINI.md — Wes's global working agreement (Antigravity CLI)

GENERATED FILE. Do not hand-edit: \`node ~/.claude/tools/harness-sync/sync.cjs\`
overwrites it. Edit the source instead: \`~/.claude/CLAUDE.md\`.

Everything below applies to agy work. A repo's own AGENTS.md or GEMINI.md and my
explicit instructions override this file.

## How this harness differs from the Claude one

The safety layer is shared. \`~/.gemini/config/hooks.json\` runs the same guard
scripts from \`~/.claude/hooks\` through a translation shim
(\`~/.claude/hooks/adapters/agy-adapter.cjs\`), because agy speaks a different hook
dialect. The global git pre-commit hook is machine-wide, so the secret scan and
manifest gate already cover agy commits.

Tool-name mapping when a rule below names a Claude tool:

| Rule says | In agy |
|---|---|
| Bash / PowerShell | \`run_command\` |
| Write | \`write_to_file\` |
| Edit / MultiEdit | \`replace_file_content\` |
| Read | \`view_file\` |
| Grep / Glob | \`grep_search\` / \`list_dir\` |
| Agent / Task | \`define_subagent\` + \`invoke_subagent\` |
| Artifact | no equivalent; write a file and say where it is |

agy also has two capabilities the Claude harness lacks a direct match for:
\`schedule\` for its own recurring tasks, and \`generate_image\`.

Model routing: the Opus/Fable/Sonnet/Haiku ladder does not apply. Run \`agy models\`
to see what actually resolves before naming one; do not write a model id you have
not confirmed.

Guards active in this harness: secret-guard, process-kill-guard, dev-server-guard,
scope-lock, repeat-tool-guard, correction-tracker, plus rtk output compression on
run_command. Contract and override markers: \`~/.claude/docs/harness-guards.md\`.

Not ported: bg-test-guard (agy has no matching event),
agent-model-guard, opus-handoff-inject, guard-canary, session-count.
Full parity table: \`~/.claude/docs/harness-parity.md\`.
`;

function buildRules(preamble, body, soul) {
  const stamp = `<!-- generated by ~/.claude/tools/harness-sync/sync.cjs from ~/.claude/CLAUDE.md + SOUL.md -->`;
  return [preamble.trimEnd(), '', '---', '', '# The agreement', '', body, '', '---', '', '# Identity (from SOUL.md)', '', soul.trim(), '', stamp, ''].join('\n');
}

// ---------------------------------------------------------------------------
// 2. Skills: junctions into ~/.claude/skills
// ---------------------------------------------------------------------------

// Skills that only make sense inside Claude Code. Everything else in
// ~/.claude/skills is linked (2026-09-05: "identical capabilities", not a curated
// nineteen). Reasons are load-bearing: a skill listed here is invisible in Codex.
const SKILL_EXCLUDE = {
  'adversarial-review': 'runs the Claude-only Workflow tool',
  'show-me': 'renders through the Claude-only Artifact tool',
  meditate: 'operates on Claude Code\'s own meditation state',
  'harness-health': 'audits Claude Code\'s settings.json and plugins',
  team: 'fans out to Claude Code + OpenClaw from a Claude session',
  'fable-gpt': 'orchestrates Codex from Claude; circular from inside Codex',
};

/**
 * @param {boolean} readsAgentsSkills  the target reads ~/.agents/skills natively
 *   (Codex does, per its skills doc), so a skill that also lives there is skipped
 *   or it would be listed twice. agy is not documented to, so it gets them linked.
 */
function skillCandidates(readsAgentsSkills) {
  const names = [];
  for (const e of fs.readdirSync(SKILL_SRC, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.name.endsWith('-workspace')) continue; // scratch variants of launch/de-vibe
    if (SKILL_EXCLUDE[e.name]) continue;
    const full = path.join(SKILL_SRC, e.name);
    if (!fs.existsSync(path.join(full, 'SKILL.md'))) continue;
    if (readsAgentsSkills && (e.isSymbolicLink() || fs.existsSync(path.join(HOME, '.agents', 'skills', e.name)))) continue;
    names.push(e.name);
  }
  return names.sort();
}

/**
 * Link every candidate skill into a harness's skills directory and prune links we
 * own that no longer resolve or are no longer wanted. Junctions, not copies: a
 * skill edited in ~/.claude/skills is instantly live everywhere, and there is no
 * second copy to drift. Never deletes a real directory.
 */
function linkSkills(dir, wanted, report) {
  fs.mkdirSync(dir, { recursive: true });
  let linked = 0;
  let already = 0;
  let pruned = 0;
  const wantedSet = new Set(wanted);
  let pending = 0; // --check: changes a real run would make
  const plain = (p) => path.resolve(String(p).replace(/^\\\\\?\\/, '')).toLowerCase();
  const ownsLink = (target) => target && plain(target).startsWith(plain(SKILL_SRC) + path.sep);

  for (const e of fs.readdirSync(dir)) {
    const dest = path.join(dir, e);
    let target = null;
    try {
      target = fs.readlinkSync(dest);
    } catch {
      continue; // a real directory: not ours
    }
    if (!ownsLink(target)) continue;
    const stale = !fs.existsSync(target) || !wantedSet.has(e);
    if (!stale) continue;
    if (CHECK_ONLY) {
      report.push(`  would prune ${e} (${fs.existsSync(target) ? 'excluded' : 'dangling'})`);
      pending++;
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    pruned++;
  }

  for (const name of wanted) {
    const src = path.join(SKILL_SRC, name);
    const dest = path.join(dir, name);
    let current = null;
    try {
      current = fs.readlinkSync(dest);
    } catch {
      current = null;
    }
    if (current && plain(current) === plain(src)) {
      already++;
      continue;
    }
    if (CHECK_ONLY) {
      report.push(`  would link ${name}`);
      pending++;
      continue;
    }
    if (current && !ownsLink(current)) {
      report.push(`  skipped ${name} (link belongs to another source)`);
      continue;
    }
    if (current) fs.rmSync(dest, { recursive: true, force: true });
    else if (fs.existsSync(dest)) {
      report.push(`  skipped ${name} (a real directory already exists there)`);
      continue;
    }
    try {
      fs.symlinkSync(src, dest, 'junction');
      linked++;
    } catch (e) {
      report.push(`  FAILED ${name}: ${e.message}`);
    }
  }
  report.push(`  skills: ${already} already linked, ${linked} newly linked, ${pruned} pruned, ${wanted.length} wanted`);
  return CHECK_ONLY ? pending : linked + pruned;
}

// ---------------------------------------------------------------------------
// 3. Hooks: ~/.claude/settings.json -> ~/.codex/config.toml (+ trust in config.toml)
// ---------------------------------------------------------------------------

// Events Codex 0.153 exposes (developers.openai.com/codex/hooks, read 2026-09-05).
const CODEX_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);

// Hooks that must not be carried over, with the reason (shown by --explain and in
// the parity page). A hook not listed here and present in settings.json is copied.
const HOOK_EXCLUDE = [
  [/agent-model-guard/, 'caps Claude\'s Fable spawns'],
  [/capability-graph-guard/, 'polices the Claude model ladder'],
  [/fable-delegate-guard/, 'Fable-main-loop budget; Codex runs GPT'],
  [/opus-handoff-inject/, 'Opus-specific'],
  [/guard-canary/, 'reads Claude\'s own guard state'],
  [/session-count/, 'counts Claude transcripts'],
  [/output-secret-watch/, 'needs MessageDisplay, Claude-only'],
  [/skill-telemetry/, 'reads the Claude transcript'],
  [/sync-main-checkout/, 'housekeeping; one agent runs the git sync'],
  [/context-nudge/, 'reads the Claude statusline context percentage'],
  [/dashclaw_pretool|dashclaw_posttool|dashclaw_stop|enforcement_liveness_probe/, 'Codex-specific DashClaw handlers come from codex-hooks.json'],
  [/repowise-rewrite|rtk hook claude/, 'replaced by hooks/adapters/codex-rewrite.cjs (Codex needs permissionDecision allow with updatedInput)'],
];

// Claude tool names -> Codex matcher tokens. `null` drops the token.
const TOOL_MAP = {
  Bash: 'Bash', PowerShell: 'Bash',
  Edit: 'Edit', Write: 'Write', MultiEdit: 'Edit', NotebookEdit: 'Edit',
  Agent: 'Agent', Task: 'Agent', Workflow: 'Agent',
  Read: null, Glob: null, Grep: null, TaskStop: null, WebFetch: null, WebSearch: null,
};

function translateMatcher(matcher) {
  if (matcher == null || matcher === '' || matcher === '*') return undefined; // omit = match all
  const out = [];
  for (const tok of String(matcher).split('|')) {
    const mapped = Object.prototype.hasOwnProperty.call(TOOL_MAP, tok) ? TOOL_MAP[tok] : tok;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.length ? out.join('|') : null; // null = every token dropped, drop the group
}

// Codex-only additions, appended after the translated Claude hooks.
function codexExtraHooks() {
  const H = (p) => `node "${path.join(HOME, '.claude', 'hooks', p).replace(/\\/g, '/')}"`;
  return {
    PreToolUse: [
      {
        matcher: 'apply_patch',
        hooks: [{ type: 'command', command: H('rm-guard.cjs'), timeout: 10 }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: H('adapters/codex-rewrite.cjs'), timeout: 8, statusMessage: 'rtk/repowise rewrite...' }],
      },
    ],
    SessionStart: [
      {
        hooks: [{ type: 'command', command: H('codex-memory-inject.cjs'), timeout: 10, statusMessage: 'Loading shared memory...', additionalContextLimit: 12000 }],
      },
    ],
  };
}

function codexHooks() {
  const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  if (!settings.hooks || Array.isArray(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse) || !settings.hooks.PreToolUse.length) throw new Error('Missing source hooks');
  const src = settings.hooks;
  const hooks = {};
  const dropped = [];
  const kept = [];

  for (const [event, groups] of Object.entries(src)) {
    if (!CODEX_EVENTS.has(event)) {
      dropped.push(`${event}: no such Codex event`);
      continue;
    }
    for (const group of groups || []) {
      const matcher = translateMatcher(group.matcher);
      if (matcher === null) {
        dropped.push(`${event} [${group.matcher}]: no Codex tool behind this matcher`);
        continue;
      }
      const handlers = [];
      for (const h of group.hooks || []) {
        if (h.type !== 'command' || !h.command) continue;
        const ex = HOOK_EXCLUDE.find(([re]) => re.test(h.command));
        if (ex) {
          dropped.push(`${event}: ${h.command.slice(0, 60)} — ${ex[1]}`);
          continue;
        }
        const out = { type: 'command', command: h.command };
        if (h.timeout != null) out.timeout = h.timeout;
        if (h.statusMessage) out.statusMessage = h.statusMessage;
        if (h.async) out.async = true;
        handlers.push(out);
        kept.push(h.command);
      }
      if (!handlers.length) continue;
      const g = matcher === undefined ? { hooks: handlers } : { matcher, hooks: handlers };
      (hooks[event] = hooks[event] || []).push(g);
    }
  }

  for (const [event, groups] of Object.entries(codexExtraHooks())) {
    (hooks[event] = hooks[event] || []).push(...groups);
    for (const g of groups) for (const h of g.hooks) kept.push(h.command);
  }

  // Preserve Codex-specific governance hooks in the same generated TOML layer.
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'codex-hooks.json'), 'utf8'));
  for (const [event, groups] of Object.entries(local.hooks)) {
    for (const group of groups) {
      const handlers = group.hooks.filter((h) => !(hooks[event] || []).some((g) =>
        g.matcher === group.matcher && g.hooks.some((existing) => existing.command === h.command)));
      if (handlers.length) (hooks[event] = hooks[event] || []).push({ ...group, hooks: handlers });
      kept.push(...handlers.map((h) => h.command));
    }
  }

  const guardNames = [...new Set(kept.map((c) => {
    if (/context_handoff_bundle/.test(c)) return 'context-handoff-checkpoint';
    if (/SoundPlayer/.test(c)) return 'stop-sound';
    const m = c.match(/([A-Za-z0-9_-]+)\.(?:cjs|ps1|py|mjs)/);
    return m ? m[1] : c.split(/\s+/)[0];
  }))];

  const json = {
    description:
      'GENERATED by ~/.claude/tools/harness-sync/sync.cjs from ~/.claude/settings.json. Do not hand-edit; edit settings.json and re-run the sync. Trust entries live in config.toml [hooks.state].',
    hooks,
  };
  return { json, dropped, guardNames };
}

// --- trust ------------------------------------------------------------------
//
// Codex records trust per hook as sha256 over a normalized identity
// (codex-rs/hooks/src/engine/discovery.rs::hook_hash, tag rust-v0.153.4):
//   identity = { event_name: <snake label>, matcher?, hooks: [normalized handler] }
//   normalized handler = { type:"command", command, async, timeout (default 600),
//                          statusMessage?, additionalContextLimit? (omitted when 2500) }
//   hash = sha256( canonical JSON: keys sorted recursively, compact )
// Verified 2026-09-05 against a hook Codex itself trusted that morning
// (config.toml:pre_tool_use:1:0 -> sha256:ada75797...). selfTestTrustHash() keeps
// that proof alive: if Codex changes the scheme, the sync says so instead of
// writing hashes that silently never match.
const EVENT_LABEL = {
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact', PostCompact: 'post_compact', SessionStart: 'session_start', SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop',
  Stop: 'stop', Interrupt: 'interrupt',
};
const NO_MATCHER_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart']);

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

function hookHash(event, matcher, h) {
  let timeout = h.timeout == null ? 600 : Number(h.timeout);
  if (event === 'SessionEnd' || event === 'Interrupt') timeout = Math.min(Math.max(h.timeout == null ? 1 : Number(h.timeout), 1), 3);
  else timeout = Math.max(timeout, 1);
  const handler = { type: 'command', command: h.command, async: !!h.async, timeout };
  if (h.statusMessage) handler.statusMessage = h.statusMessage;
  if (CONTEXT_EVENTS.has(event) && h.additionalContextLimit != null && h.additionalContextLimit !== 2500) {
    handler.additionalContextLimit = h.additionalContextLimit;
  }
  const identity = { event_name: EVENT_LABEL[event], hooks: [handler] };
  if (!NO_MATCHER_EVENTS.has(event) && matcher != null) identity.matcher = matcher;
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
}

function selfTestTrustHash() {
  const known = hookHash('PreToolUse', 'Bash|Edit|Write|MultiEdit|apply_patch|mcp__.*', {
    command: 'node "C:/Projects/agnostic-ai/engine/hooks/dashclaw-guard.cjs"',
    timeout: 60,
  });
  return known === 'sha256:ada757977119bf80c0f1c6fecb2e0ce58394b725fe690d40dcd2a4fbc41f4f9c';
}

/** Rewrite the [hooks.state] entries for ~/.codex/config.toml inside config.toml. */
function trustHooksInConfig(hooksJson, out) {
  const keySource = CODEX_CONFIG;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entries = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks)) {
    groups.forEach((g, gi) => {
      g.hooks.forEach((h, hi) => {
        const key = `${keySource}:${EVENT_LABEL[event]}:${gi}:${hi}`;
        entries.push(`[hooks.state.'${key}']\nenabled = true\ntrusted_hash = "${hookHash(event, g.matcher, h)}"`);
      });
    });
  }

  let toml = read(CODEX_CONFIG);
  if (toml == null) {
    out.push('  trust: ~/.codex/config.toml not found; skipped');
    return false;
  }
  // Deterministic rebuild so a second run is a no-op: drop the managed region, drop
  // any stray state block for this key source left by Codex or an older sync (a
  // block is the header plus the non-blank lines after it, so neighbouring comments
  // survive), collapse the blank lines that leaves behind, append a fresh region.
  const START = '# >>> harness-sync hook trust start — generated, do not edit';
  const END = '# <<< harness-sync hook trust end';
  const regionRe = new RegExp(`\\n*${esc(START)}[\\s\\S]*?${esc(END)}\\n?`, 'g');
  const blockRe = new RegExp(`\\[hooks\\.state\\.(?:'|")${esc(keySource)}:[^'"]*(?:'|")\\]\\r?\\n(?:[^\\n\\[][^\\n]*\\r?\\n?)*`, 'g');
  // Replace hook tables only, preserving every unrelated configuration table.
  let next = toml.replace(regionRe, '\n').replace(blockRe, '');
  next = next.replace(/^\[\[?hooks(?:\.[^\n]*)?\]\]?[^\n]*\n[\s\S]*?(?=^\[|$(?![\s\S]))/gm, (block) => {
    if (block.startsWith('[hooks.state.') && !block.includes(keySource + ':') &&
        !block.includes(path.join(CODEX_HOME, 'hooks.json') + ':')) return block;
    return '';
  });
  const definitions = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks)) {
    for (const group of groups) {
      definitions.push(`[[hooks.${event}]]`);
      if (group.matcher != null) definitions.push(`matcher = ${JSON.stringify(group.matcher)}`);
      for (const handler of group.hooks) {
        definitions.push(`[[hooks.${event}.hooks]]`);
        for (const [key, value] of Object.entries(handler)) definitions.push(`${key} = ${JSON.stringify(value)}`);
      }
      definitions.push('');
    }
  }
  next = next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n\n') + `${START}\n${definitions.join('\n')}\n${entries.join('\n\n')}\n${END}\n`;
  if (next === toml) {
    out.push(`  trust: ${entries.length} hook trust entries already current in config.toml`);
    return false;
  }
  if (CHECK_ONLY) {
    out.push(`  STALE  trust entries in config.toml (${entries.length} hooks)`);
    return true;
  }
  fs.writeFileSync(CODEX_CONFIG, next);
  out.push(`  trust: wrote ${entries.length} hook trust entries into config.toml`);
  return true;
}

// ---------------------------------------------------------------------------
// 4. Agents: ~/.claude/agents/*.md -> ~/.codex/agents/*.toml
// ---------------------------------------------------------------------------
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

const tomlStr = (s) => JSON.stringify(String(s)); // TOML basic strings share JSON escaping
function tomlMultiline(s) {
  // Triple-quoted basic string; escape a literal """ and a trailing backslash-newline.
  return '"""\n' + String(s).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '\n"""';
}

function codexAgents() {
  const files = fs.existsSync(CLAUDE_AGENTS) ? fs.readdirSync(CLAUDE_AGENTS).filter((f) => f.endsWith('.md')) : [];
  const agents = [];
  for (const f of files) {
    const { meta, body } = parseFrontmatter(read(path.join(CLAUDE_AGENTS, f)) || '');
    const name = meta.name || f.replace(/\.md$/, '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid agent name');
    const [, model, effort] = ladderFor(meta.model || 'opus');
    const tools = (meta.tools || '').split(',').map((t) => t.trim());
    const readOnly = !tools.some((t) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t));
    const header =
      `Generated from ~/.claude/agents/${f} by ~/.claude/tools/harness-sync/sync.cjs. ` +
      `Codex port: "Agent tool"/"subagent_type" means spawn_agent with agent_type; Bash/PowerShell is the shell tool; ` +
      `Edit/Write is apply_patch; Read/Grep/Glob are shell reads. Rules referring to a model guard describe the Claude harness; ` +
      `in Codex the model is fixed by this file (${model}, ${effort}).` +
      (readOnly ? ' This agent is read-only (sandbox_mode = "read-only").' : '');
    const toml = [
      `# GENERATED — do not edit; source is ~/.claude/agents/${f}`,
      `name = ${tomlStr(name)}`,
      `description = ${tomlStr(meta.description || name)}`,
      `model = ${tomlStr(model)}`,
      `model_reasoning_effort = ${tomlStr(effort)}`,
      ...(readOnly ? ['sandbox_mode = "read-only"'] : []),
      `developer_instructions = ${tomlMultiline(header + '\n\n' + body.trim())}`,
      '',
    ].join('\n');
    agents.push({ name, file: path.join(CODEX_HOME, 'agents', `${name}.toml`), toml });
  }
  return agents;
}

// ---------------------------------------------------------------------------
// 5. Prompts: ~/.claude/commands/*.md -> ~/.codex/prompts/*.md
// ---------------------------------------------------------------------------
function codexPrompts() {
  const files = fs.existsSync(CLAUDE_COMMANDS) ? fs.readdirSync(CLAUDE_COMMANDS).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
  const prompts = [];
  for (const f of files) {
    const md = read(path.join(CLAUDE_COMMANDS, f)) || '';
    const { meta, body } = parseFrontmatter(md);
    // Codex reads description and argument-hint; allowed-tools is Claude-only.
    const fm = ['---'];
    if (meta.description) fm.push(`description: ${meta.description}`);
    if (meta['argument-hint']) fm.push(`argument-hint: ${meta['argument-hint']}`);
    fm.push('---');
    prompts.push({ name: f.replace(/\.md$/, ''), file: path.join(CODEX_HOME, 'prompts', f), md: fm.join('\n') + '\n\n' + body.trim() + '\n' });
  }
  return prompts;
}

/** Remove generated files in a directory that no longer have a source. Only files listed in the manifest are ours. */
function pruneGenerated(dir, keep, manifestName, out) {
  const manifest = path.join(dir, manifestName);
  const prev = readJSON(manifest) || [];
  if (!Array.isArray(prev) || prev.some(f => typeof f !== 'string' || !/^[a-z0-9-]+\.(?:toml|md)$/.test(f))) throw new Error('Invalid generated-file manifest');
  let pruned = 0;
  for (const f of prev) {
    const p = path.join(dir, f);
    if (!keep.includes(f) && fs.existsSync(p)) {
      if (CHECK_ONLY) { out.push(`  would prune ${p}`); pruned++; }
      else {
        fs.unlinkSync(p);
        pruned++;
      }
    }
  }
  if (!CHECK_ONLY) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify(keep, null, 2));
  }
  return pruned;
}

// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`harness-sync: source not found: ${SOURCE}`);
    process.exit(1);
  }
  const source = fs.readFileSync(SOURCE, 'utf8');
  const soul = fs.existsSync(SOUL) ? fs.readFileSync(SOUL, 'utf8') : '(SOUL.md not present)';
  const body = rulesBody(source);
  const out = [];
  let stale = 0;

  // --- Codex ---------------------------------------------------------------
  const { json: hooksJson, dropped, guardNames } = codexHooks();
  const agents = codexAgents();
  const prompts = codexPrompts();
  const skills = skillCandidates(true);
  const agySkills = skillCandidates(false);

  const preamble = codexPreamble({ guardNames, agentNames: agents.map((a) => a.name), promptNames: prompts.map((p) => p.name) });
  if (emit(path.join(CODEX_HOME, 'AGENTS.md'), buildRules(preamble, body, soul), 'Codex rules', out)) stale++;

  if (!selfTestTrustHash()) {
    out.push('  ALERT: trust-hash self-test failed (Codex changed its hook identity scheme); hooks written but NOT pre-trusted. Open /hooks in Codex to trust them, then fix hookHash().');
  } else if (trustHooksInConfig(hooksJson, out)) stale++;
  const legacyHooks = path.join(CODEX_HOME, 'hooks.json');
  if (fs.existsSync(legacyHooks)) {
    if (CHECK_ONLY) { out.push('  STALE legacy hooks.json duplicates TOML hooks'); stale++; }
    else {
      const backup = path.join(CODEX_HOME, `hooks.json.backup-${Date.now()}`);
      fs.renameSync(legacyHooks, backup);
      out.push('  archived legacy hooks.json; config.toml is the executable hook source');
    }
  }
  for (const d of dropped) out.push(`  not ported: ${d}`);

  for (const a of agents) if (emit(a.file, a.toml, `Codex agent ${a.name}`, out)) stale++;
  if (pruneGenerated(path.join(CODEX_HOME, 'agents'), agents.map((a) => path.basename(a.file)), '.harness-sync.json', out)) stale++;

  for (const p of prompts) if (emit(p.file, p.md, `Codex prompt ${p.name}`, out)) stale++;
  if (pruneGenerated(path.join(CODEX_HOME, 'prompts'), prompts.map((p) => path.basename(p.file)), '.harness-sync.json', out)) stale++;

  if (linkSkills(path.join(CODEX_HOME, 'skills'), skills, out) && CHECK_ONLY) stale++;

  // --- agy -----------------------------------------------------------------
  if (emit(path.join(HOME, '.gemini', 'GEMINI.md'), buildRules(AGY_PREAMBLE, body, soul), 'agy rules', out)) stale++;
  if (linkSkills(path.join(HOME, '.gemini', 'config', 'skills'), agySkills, out) && CHECK_ONLY) stale++;

  for (const line of out) console.log(line);
  if (CHECK_ONLY && stale) {
    console.error(`\nharness-sync: ${stale} item(s) stale. Run without --check to regenerate.`);
    process.exit(1);
  }
  if (!stale) console.log('\nall harness targets in sync');
}

main();
