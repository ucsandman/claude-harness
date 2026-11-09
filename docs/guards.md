---
name: harness-guards
description: "Every guard hook and gate in this harness: what it stops, its override marker, and how to check wiring"
context:
  triggers:
    keywords: ["guard", "hook denied", "override marker", "rm_ok", "slow_ok", "batch-guard", "gate-freeze", "pre-commit blocked", "why was that blocked"]
    paths: ["~/.claude/hooks/**", "~/.claude/settings.json"]
  priority: 70
---
# Harness guards

Guard behavior and overrides. Standing rules live in `CLAUDE.md`.

Check wiring with `node ~/.claude/tools/gates/gates.cjs hook-wiring`.

## Global git pre-commit

`core.hooksPath` = `~/.claude/git-hooks`.

Order:

1. Chain the repo's `.git/hooks/pre-commit`, when present.
2. `secret-guard.cjs --scan-staged` over **every** staged file, any language.
3. Harness doc gates, inside `~/.claude` only, when a `.md` or `settings.json`
   is staged.
4. On staged `.py` only: `ruff` auto-fixes imports and format, `vulture` reports
   dead code at 60% confidence and **blocks** without deleting anything.

Bypass everything: `git commit --no-verify`.

The staged scan also covers commits made outside an agent session.

## Path handoff to native node

The pre-commit hook passes `cygpath -w` paths to `node.exe`: [windows-gotchas.md](windows-gotchas.md), gotcha 15.

## agent-model-guard.cjs

Blocks any Agent, Task, or Workflow spawn with no explicit `model:`. Caps Fable
spawns at 3 per session (`AGENT_GUARD_FABLE_CAP` to override). In a Workflow
script a Fable `agent()` passes only as a module-top-level `await agent(...)`
outside every fan-out span (max 3 sites): the synthesizer/judge role since
2026-09-01. Denied inside parallel/pipeline/map/loop, inside any block or
hoisted helper, or without `await`. Probe: `hooks/tests/fable-synth-probe.cjs`.


## process-kill-guard.cjs

Blocks name-based process termination in Bash and PowerShell —
`Stop-Process -Name`, `Get-Process <name> | Stop-Process`, `taskkill /IM`,
`pkill`, `killall` — and allows the PID-based forms. It also denies `& $var`,
`iex`, and `Invoke-Expression` carrying `-Name`, because a dynamic invocation
cannot be verified.

Capture PIDs at launch. Override marker: `KILL_BY_NAME_OK`.

## scope-lock.cjs

Blocks Edit, Write, MultiEdit, and NotebookEdit outside the locked directory.
Arm with `scope-lock <dir>` as a prompt; lift with `scope-unlock`. State lives
in `~/.claude/scope-locks/`. Bash and PowerShell are **not** intercepted, so
stay inside the scope by hand there.

## repeat-tool-guard.cjs

Counts consecutive identical tool calls and injects an escalating reminder at 3,
5, and 8. Advisory — it never blocks. `REPEAT_GUARD_OFF=1` disables it.
Since 2026-09-18 a streak whose every call FAILED (`PostToolUseFailure`) gets a
different text ("keeps failing the same way, fix the input"), and every threshold
fire is logged to `logs/repeat-guard.jsonl` (`--report`), so whether termination
would ever pay is a question the log answers. Probe: `hooks/tests/repeat-guard-probe.cjs`.
Rationale: [decisions/feature/2026-08-17-repeat-tool-call-guard.md](decisions/feature/2026-08-17-repeat-tool-call-guard.md);
the failing/succeeding split and the log follow arXiv:2609.20804 §A.4.

## post-edit-diagnostics.cjs (2026-09-18)

PostToolUse on `Edit|Write|MultiEdit`. Advisory. Runs the cheapest read-only check
the edited file's language has and returns findings on the same tool result:
`ruff` error-only rules (`E9,F63,F7,F82`) for `.py`, `node --check` for
`.js/.cjs/.mjs`, `JSON.parse` for `.json`; `.ts/.tsx` are left to the
typescript-lsp plugin. Silent on a clean file, on a missing checker, and on a
timeout. Every run is logged to `logs/post-edit-diagnostics.jsonl` (`--report`).
`POST_EDIT_DIAG_OFF=1` disables. Probe: `hooks/tests/post-edit-diagnostics-probe.cjs`.
A syntax error in one of these `.cjs` guards disables the guard silently; this
surfaces it on the edit turn.

## compaction-ledger.cjs and precompact-extract.cjs (2026-09-18)

`compaction-ledger.cjs` on `PreCompact` and `PostCompact` appends one row per
event with `context_window_stats` to `logs/compaction.jsonl` (`--report`: count,
auto share, mean context before, tokens freed). Observation only. It is how a
change to `autoCompactWindow` gets judged.

`precompact-extract.cjs` read `evt.transcript`, a field the PreCompact payload
never carries, so it had never written a line. It now reads the tail of
`transcript_path` (human and assistant text only) and works as documented.

## context-graph.cjs (2026-09-19)

`UserPromptSubmit`, `PreToolUse` (Edit/Write, Bash/PowerShell and Agent), `SubagentStart`,
`SessionStart` (compact, clear). Advisory: injects context, never blocks.
Selects context modules from the prompt, the cwd, the file being edited or the
command about to run (it absorbed `dynamic-recall.cjs` on 2026-09-19),
resolves their dependency closure and injects it under a hard budget, each
module naming why it loaded. Ledger `logs/context-graph.jsonl` (`--report`).
Probe: `hooks/tests/context-graph-probe.cjs`. Contract, roots, budgets:
[context-graph.md](context-graph.md).

## declick-nudge.cjs (2026-09-03)

PreToolUse on `mcp__.*|WebFetch`. Advisory. Names the adapter and verb once per session
when an MCP call, WebFetch or Chrome read has one. `DECLICK_NUDGE_OFF=1` disables. Probe:
`hooks/tests/declick-nudge-probe.cjs`. Details: [declick-first.md](declick-first.md).

## git-tree-guard.cjs (2026-09-03)

Denies git commands that rewrite a working tree other agents may be editing: `git stash` (push, pop, apply, drop), `git checkout` or `git restore` of paths, `git reset --hard|--merge|--keep`, `git clean`, `git switch --discard-changes`. Reads, branch creation and commits pass. Override for a deliberate solo-session use: `# GIT_TREE_OK: <why>`, logged to `~/.claude/logs/git-tree-guard.log`. Incident, prompt-side fix and the 18-case self-test: [decisions/feature/2026-09-03-git-tree-guard.md](decisions/feature/2026-09-03-git-tree-guard.md).

## wiredark, gate-freeze, slopsquat-guard (2026-09-06)

Three ports from ELAI's archive; rationale in
`docs/decisions/process/2026-09-06-wire-dark-and-gate-freeze.md`.

- `tools/wiredark/wiredark.cjs`, in every repo's pre-commit: a new JS/TS/Python
  export with no non-test caller outside its file blocks. `// WIRE-DARK[<why>]`
  above it registers a deliberate dark export. `WIREDARK=off` for one shell.
- `hooks/gate-freeze.cjs` denies a write to a frozen guard file
  (`tools/gates/gate-manifest.json`) from a cwd outside a harness root;
  `gates.cjs gate-freeze` fails on hash drift. Relock: `gates.cjs --lock`.
- `hooks/slopsquat-guard.cjs` looks every package in an npm/pip/uv/cargo
  install up on its registry first. NOT FOUND, STALE (24 months), BRAND NEW
  (14 days) and UNVERIFIED deny. `# PKG_OK: <why>` after checking by hand.

## Codex adapters (2026-09-05)

Codex runs the guards above from generated hooks in `~/.codex/config.toml` ([parity.md](parity.md)), plus three Codex-only adapters: `codex-rewrite.cjs` (rtk rewrite), `codex-delegate-guard.cjs` (delegate-first for an astra main loop, `wait_agent` timeout floor, `# ASTRA_OK` override) and `codex-memory-inject.cjs`. Behavior, probes and overrides: [codex-adapters.md](codex-adapters.md).

## A guard registered is not a guard running

Scope locks inspect every patch source and move destination. Codex's Edit/Write
matcher aliases still deliver `tool_name: apply_patch`, with patch text in command.
The shared protocol adapter identifies Codex by its lifecycle `turn_id` and emits
an empty object for ordinary approvals. `allow` is reserved for actual rewrites.

Verify both matcher dispatch and payload parsing with positive and negative
controls. Probes: `~/.claude/hooks/tests/`.

## Automatic compaction

Automatic compaction is allowed as of 2026-09-05. The blocking PreCompact
registration was removed. `hooks/no-auto-compact.cjs` exits silently for sessions
that cached it. Preserve task state and verification evidence in handoffs.

## rtk test-runner exclusion

`exclude_commands` in `~/AppData/Roaming/rtk/config.toml` excludes vitest/jest/npm-test
because compression hid import failures. Git, tsc and eslint still compress.

`exclude_commands` matches from the START of the command and takes regex: bare `"vitest"`
will NOT exclude `npx vitest run`. Dry-run with `rtk hook check "<cmd>"`.

**Verify test runs by exit code, never the count.**

## prompt-dispatch.cjs and wakeup-guard.cjs (2026-09-19)

UserPromptSubmit is one process; a third machine wake-up in a row is told to
stop saying "Waiting.": [prompt-dispatch.md](prompt-dispatch.md).

## turn-close.cjs (2026-11-09)

`Stop`, cli only; replaced `forced-verify-stop-gate.cjs`. Stores the closing `Next`
line for opening-move and flags a code edit with no passing check after it: shadow
(default) logs, enforce blocks once per human prompt; `TURN_CLOSE_MODE=off|shadow|enforce`
beats `verifyGate` in `config.json`. Spec 2.4 deviation: `|`/`;`/`||`/`&`-masked checks never pass.

## Hook latency pass (2026-09-06)

Timings, ports, removals: [hook-latency.md](hook-latency.md).
