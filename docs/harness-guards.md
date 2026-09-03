# Harness guards

What each guard blocks, why it exists, and how to override it. Standing rules
live in `CLAUDE.md` (Environment Facts); this file holds the mechanism and the
incidents.

Check wiring with `node ~/.claude/tools/gates/gates.cjs hook-wiring`.

## Global git pre-commit

`core.hooksPath` = `C:/Users/sandm/.claude/git-hooks`. Installed 2026-04-09;
moved into the version-controlled harness repo 2026-08-11, which is what put it
under backup.

Order:

1. The repo's own `.git/hooks/pre-commit`, if it has one. When `core.hooksPath`
   is set git skips `.git/hooks/`, so the chain is manual.
2. `secret-guard.cjs --scan-staged` over **every** staged file, any language.
3. Harness doc gates, inside `~/.claude` only, when a `.md` or `settings.json`
   is staged.
4. On staged `.py` only: `ruff` auto-fixes imports and format, `vulture` reports
   dead code at 60% confidence and **blocks** without deleting anything.

Bypass everything: `git commit --no-verify`.

The secret scan is the last line of defence: the `PreToolUse` secret-guard only
sees Claude Code's own tool calls, so commits made by Codex, a second agent, or
by hand in a terminal never pass through it.

## Path handoff to native node

The pre-commit hook passes `cygpath -w` paths to `node.exe`: [windows-gotchas.md](windows-gotchas.md), gotcha 15.

## agent-model-guard.cjs

Blocks any Agent, Task, or Workflow spawn with no explicit `model:`. Caps Fable
spawns at 3 per session (`AGENT_GUARD_FABLE_CAP` to override). In a Workflow
script a Fable `agent()` passes only as a module-top-level `await agent(...)`
outside every fan-out span (max 3 sites): the synthesizer/judge role since
2026-09-01. Denied inside parallel/pipeline/map/loop, inside any block or
hoisted helper, or without `await`. Probe: `hooks/tests/fable-synth-probe.cjs`.

Asymmetric on purpose: a false positive costs a marker append; a false negative
cost a five-hour usage window on 2026-06-12, when one unrouted workflow spawned
110 Fable agents.

## process-kill-guard.cjs

Blocks name-based process termination in Bash and PowerShell —
`Stop-Process -Name`, `Get-Process <name> | Stop-Process`, `taskkill /IM`,
`pkill`, `killall` — and allows the PID-based forms. It also denies `& $var`,
`iex`, and `Invoke-Expression` carrying `-Name`, because a dynamic invocation
cannot be verified.

Added 2026-08-12 after a subagent cleaning up its own test window ran
`Stop-Process -Name notepad` and killed a real Notepad session with ~40 tabs and
unsaved work.

The standing rule (capture the PID at start, never look it up by name) lives in
`CLAUDE.md`. Override marker: `KILL_BY_NAME_OK`.

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

## A guard registered is not a guard running

From the 2026-08-16 audit: `secret-guard.cjs` was registered on `PowerShell`,
but `main()`'s switch had no PowerShell case, so it hit `default: exit(0)`.
Every scan was a no-op on half the tool surface. A matcher was widened without
widening the dispatch.

For every hook, assert the script dispatches on every tool name its matcher
claims, and watch the probe fail before trusting it. Probes:
`~/.claude/hooks/tests/`.

## rtk test-runner exclusion (2026-08-17)

`rtk vitest` reported `PASS (34) FAIL (0)` for a suite whose test file failed to import: it
contributes zero tests, so counts read green though it never ran. `[hooks]
exclude_commands` in `~/AppData/Roaming/rtk/config.toml` now excludes vitest/jest/npm-test;
`git`/`tsc`/`eslint` still compress. That config had also not parsed since 2026-07-07
(`[tee]` missing `max_files`), so its settings were ignored. Regenerated; backups
`*.bak-2026-08-17`.

`exclude_commands` matches from the START of the command and takes regex: bare `"vitest"`
will NOT exclude `npx vitest run`. Dry-run with `rtk hook check "<cmd>"`.

**Verify test runs by exit code, never the count.**
