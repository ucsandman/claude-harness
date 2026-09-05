# Harness guards

Guard behavior and overrides. Standing rules live in `CLAUDE.md`.

Check wiring with `node ~/.claude/tools/gates/gates.cjs hook-wiring`.

## Global git pre-commit

`core.hooksPath` = `C:/Users/sandm/.claude/git-hooks`.

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
Rationale: [decisions/feature/2026-08-17-repeat-tool-call-guard.md](decisions/feature/2026-08-17-repeat-tool-call-guard.md).

## declick-nudge.cjs (2026-09-03)

PreToolUse on `mcp__.*|WebFetch`. Advisory. Names the adapter and verb once per session
when an MCP call, WebFetch or Chrome read has one. `DECLICK_NUDGE_OFF=1` disables. Probe:
`hooks/tests/declick-nudge-probe.cjs`. Details: [declick-first.md](declick-first.md).

## git-tree-guard.cjs (2026-09-03)

Denies git commands that rewrite a working tree other agents may be editing: `git stash` (push, pop, apply, drop), `git checkout` or `git restore` of paths, `git reset --hard|--merge|--keep`, `git clean`, `git switch --discard-changes`. Reads, branch creation and commits pass. Override for a deliberate solo-session use: `# GIT_TREE_OK: <why>`, logged to `~/.claude/logs/git-tree-guard.log`. Incident, prompt-side fix and the 18-case self-test: [decisions/feature/2026-09-03-git-tree-guard.md](decisions/feature/2026-09-03-git-tree-guard.md).

## Codex adapters (2026-09-05)

Codex runs the guards above from generated hooks in `~/.codex/config.toml`
([harness-parity.md](harness-parity.md)). Two Codex-only pieces sit beside them:

- `hooks/adapters/codex-rewrite.cjs` — PreToolUse on `Bash`. Runs `rtk hook claude`
  then `repowise-rewrite` and re-emits the first rewrite as
  `permissionDecision: allow` + `updatedInput`.
  `CODEX_REWRITE_OFF=1` disables. Probe: pipe a `git status` payload, expect
  `rtk git status`.
- `hooks/codex-memory-inject.cjs` — SessionStart. Injects the project map, the named
  facts under `~/.agents/memory`, and `MEMORY.md` for the cwd's Claude project slug,
  using regular Markdown files contained within the memory roots.

`secret-guard.cjs` scans patch additions and move destinations. Placeholder matches
do not suppress later credential matches. `rm-guard.cjs` checks patch deletions.

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
