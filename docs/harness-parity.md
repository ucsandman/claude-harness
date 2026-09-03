# Harness parity — Claude Code, Codex CLI, Antigravity CLI

One safety layer, three agents. Built 2026-08-17. Live status page:
`node ~/.claude/tools/harness-sync/parity.cjs --open`

## The design

The guards are **not** copied into each harness. `~/.codex/hooks.json` and
`~/.gemini/config/hooks.json` point at the same scripts in `~/.claude/hooks`, so a
fix lands in all three at once and there is no second copy to drift. Same for
skills: they are Windows **junctions** into `~/.claude/skills`, not copies.

The rules files are generated, not hand-written:

```
~/.claude/CLAUDE.md + SOUL.md   ->  ~/.codex/AGENTS.md
   (source of truth)            ->  ~/.gemini/GEMINI.md
```

`node ~/.claude/tools/harness-sync/sync.cjs` regenerates both and re-links skills.
`--check` exits 1 if either is stale and writes nothing.

Why generated: both files were hand-written in June 2026 and never touched again
while CLAUDE.md kept growing (the meditation ladder promotes rules into it). By
2026-08-17 Codex and agy were running a three-month-old agreement. Three
hand-maintained copies is what caused that.

## What already covered every harness before any of this

The global git pre-commit hook (`core.hooksPath` = `~/.claude/git-hooks`) is
machine-wide, so the staged-secret scan and the manifest gate applied to Codex and
agy commits from day one. Only the in-session guards needed porting.

## Hook dialects

| | Claude Code | Codex CLI | Antigravity CLI |
|---|---|---|---|
| config | `settings.json` | `hooks.json` + `config.toml` | `~/.gemini/config/hooks.json` |
| top-level key | event name | event name | **hook name**, event nested |
| payload case | snake_case | snake_case | camelCase (protojson) |
| command field | `tool_input.command` | `tool_input.command` | `toolCall.args.CommandLine` |
| deny | `permissionDecision: deny` or exit 2 | same | `decision: deny` |
| decisions | allow / deny / ask | allow / deny / ask | allow / deny / ask / **force_ask** |
| events | 10+ incl. MessageDisplay | 11, near-identical to Claude | **only 5** |
| inject context | `additionalContext` | `additionalContext` | `PreInvocation` -> `injectSteps[].ephemeralMessage` |

Codex is close enough that the guards run unmodified. agy needs translation, which
is `~/.claude/hooks/adapters/agy-adapter.cjs` — one shim instead of a second copy of
every guard. It fails open: a crashed or unparseable hook emits `{}`, never a deny.

Self-check (proves each guard both blocks and passes):
`sh ~/.claude/hooks/adapters/test-agy-adapter.sh`

## Tool name mapping

| Claude | Codex | agy |
|---|---|---|
| Bash / PowerShell | `shell` (`shell_command` in transcripts) | `run_command` |
| Write | `apply_patch` | `write_to_file` |
| Edit / MultiEdit | `apply_patch` | `replace_file_content` |
| Read | — | `view_file` |
| Grep / Glob | — | `grep_search` / `list_dir` |
| Agent / Task | subagents (`[agents]` in config.toml) | `define_subagent` + `invoke_subagent` |
| Artifact | none | none |

The guards now accept every shell alias (`Bash`, `PowerShell`, `shell`,
`shell_command`, `run_command`). This was a real latent bug, not just a port
detail: an unrecognised `tool_name` hit `default: exit(0)` in secret-guard and
silently scanned nothing — the same way PowerShell was missed until 2026-08.

## Deliberately not ported

| Guard | Why |
|---|---|
| `agent-model-guard` | Caps Claude's Fable spawns; no equivalent routing to police |
| `opus-handoff-inject` | Opus-specific |
| `guard-canary`, `session-count` | Read Claude's own state; would report Claude's status from another harness |
| `output-secret-watch` | Needs `MessageDisplay`, which only Claude Code has |
| `bg-test-guard`, `no-auto-compact` (agy only) | agy has no `run_in_background` flag and no `PreCompact` event |
| `skill-telemetry`, `sync-main-checkout` | Housekeeping; three agents running the same git sync invites conflicts |

**Scheduled tasks are deliberately not triplicated.** The nine Task Scheduler jobs
(FleetBriefing7am, NightlyMeditation, HarnessAudit, ...) all drive `claude -p`.
Running them three times would triple the token spend for the same output. agy has
its own native `schedule` tool if it ever needs its own recurring job.

Two MCP servers were also skipped on purpose:
- **xapi** — X keeps one live OAuth grant per (client_id, user), so each agent needs
  its own X portal app plus a manual consent. Wiring it without that just fails.
- **sidetap** — one physical phone; three agents driving it concurrently is a
  conflict, not parity.

## Gotchas found while building this

- **agy keeps quotes in hook commands on Windows** and resolves them relative to
  the `hooks.json` directory. `node "C:/path/x.cjs"` failed as
  `Cannot find module 'C:\Users\sandm\.gemini\config\"C:\...\x.cjs"'`. Use unquoted
  forward-slash paths.
- **agy merges multiple hooks per event and the LAST result's `reason` wins.** A
  guard that denied with a 500-char explanation had its reason blanked by a later
  no-opinion hook: the block survived, the teaching text did not. Guards must be
  **chained into one entry** with the adapter's `++` separator. This is why
  `~/.gemini/config/hooks.json` has one PreToolUse entry, not five.
- **agy reasons are ASCII-folded and capped at 400 chars** by the adapter.
- **Codex is already at its skill-description budget** and warns that it shortened
  descriptions to fit. Adding skills there costs the others clarity, which is why
  19 curated skills are shared and not all 52. Trim with `/skills` in Codex.
- **Codex warns if hooks live in both `hooks.json` and `config.toml`.** They do:
  DashClaw manages a block in `config.toml`. Pre-existing and harmless.
- **New Codex hooks need trusting** (`/hooks` in the TUI) on first interactive use.
  `codex exec` ran them without a prompt.
- **context7 over HTTP silently did not load in agy**; the stdio server
  (`npx -y @upstash/context7-mcp@4.0.2`) worked first try. Both harnesses use stdio.

## Verifying the port

```sh
node ~/.claude/tools/harness-sync/sync.cjs --check      # rules in sync?
sh   ~/.claude/hooks/adapters/test-agy-adapter.sh       # guards block AND pass?
node ~/.claude/tools/harness-sync/parity.cjs --open     # the rendered picture
```

The parity page reads every cell from disk, so it cannot claim a guard is wired
after someone removes it. Verified by deleting one from `~/.codex/hooks.json` and
watching the count drop to 9/10 (rule L1: a check never seen failing is not
verified).
