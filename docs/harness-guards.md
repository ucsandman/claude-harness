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
3. The manifest gate (silent unless armed for this repo).
4. Harness doc gates, inside `~/.claude` only, when a `.md` or `settings.json`
   is staged.
5. On staged `.py` only: `ruff` auto-fixes imports and format, `vulture` reports
   dead code at 60% confidence and **blocks** without deleting anything.

Bypass everything: `git commit --no-verify`.

The secret scan is the last line of defence: the `PreToolUse` secret-guard only
sees Claude Code's own tool calls, so commits made by Codex, a second agent, or
by hand in a terminal never pass through it.

## Path handoff to native node

`$HOME` inside the hook is a POSIX path (`/c/Users/sandm`). Bash resolves that
fine, but `node.exe` is a native Windows binary and reads `/c/Users/...` as
`C:\c\Users\...`, so the commit dies with MODULE_NOT_FOUND. MSYS usually
auto-converts arguments but not reliably from every shell, so the hook converts
explicitly with `cygpath -w`. Observed 2026-08-12.

## manifest-gate.cjs

The only **output**-side guard. Declare intended paths and acceptance criteria
up front; the commit is blocked if it touches anything undeclared or a
`--verify` command fails. Opt-in per repo, silent when unarmed. Arm it for any
task where surgical changes actually matter. Full contract:
[manifest-gate.md](manifest-gate.md).

## agent-model-guard.cjs

Blocks any Agent, Task, or Workflow spawn with no explicit `model:`. Caps Fable
spawns at 3 per session (`AGENT_GUARD_FABLE_CAP` to override). Denies a Fable
`agent()` call anywhere in a Workflow script that fans out anywhere — hoisting
the call into a helper declared outside the loop used to defeat the older
span-based check, and the per-call-site cap missed it too.

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
Rationale: a private note.

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
