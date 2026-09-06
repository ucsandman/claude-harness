> **Superseded 2026-09-06.** The port described below is now done by the Agnostic-AI repo (C:\Projects\agnostic-ai): npm run port captures ~/.claude and applies rules, hooks (with Codex trust hashes), skills, agents, commands, MCP servers and permissions to every installed client, including Gemini CLI, Antigravity and Cursor through engine/hooks/shim.cjs. Policy (exclusions with reasons, model ladder, Codex-only extra hooks) lives in that repo's core/port.json. tools/harness-sync/sync.cjs is retired. This page stays as the design record.

# Harness parity — Claude Code, Codex CLI, Antigravity CLI

One safety layer, three agents. Built 2026-08-17, made fully generated 2026-09-05.
Live status page: `node ~/.claude/tools/harness-sync/parity.cjs --open`

## The design

The guards are **not** copied into each harness. `~/.codex/config.toml` and
`~/.gemini/config/hooks.json` point at the same scripts in `~/.claude/hooks`, so a
fix lands in all three at once and there is no second copy to drift. Same for
skills: they are Windows **junctions** into `~/.claude/skills`, not copies.

Every Codex-side file is generated from a Claude-side source by
`node ~/.claude/tools/harness-sync/sync.cjs` (daily via the `HarnessParitySync`
task; `--check` exits 1 on drift and writes nothing):

```
~/.claude/CLAUDE.md + SOUL.md   ->  ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md
~/.claude/settings.json + tools/harness-sync/codex-hooks.json
                              ->  ~/.codex/config.toml hooks + trust
~/.claude/agents/*.md           ->  ~/.codex/agents/*.toml  (custom subagents)
~/.claude/commands/*.md         ->  ~/.codex/prompts/*.md   (/prompts:<name>)
~/.claude/skills/*              ->  ~/.codex/skills/<name>  (junctions; all but 6 Claude-only)
~/.agents/memory + ~/.claude/projects/<slug>/memory  ->  injected at Codex SessionStart
```

Why generated: the rules files were hand-written in June 2026 and never touched
again while CLAUDE.md kept growing; by 2026-08-17 Codex ran a three-month-old
agreement. Then the former hand-wired Codex hooks.json was overwritten in a flat
format by agnostic-ai's first-run installer on 2026-08-18 and emptied by Codex's own
startup repair on 2026-09-05: for three weeks Codex had no guards, no shared memory,
and an AGENTS.md naming a model that was no longer configured. A hand-wired file has
no source to be regenerated from, so nothing noticed. Everything is derived now.

## Hooks: translation and trust (2026-09-05)

`codexHooks()` in sync.cjs walks settings.json and rewrites matchers
(`Bash|PowerShell` -> `Bash`; `Edit|Write|MultiEdit|NotebookEdit` -> `Edit|Write`,
which Codex aliases to `apply_patch`; `Read|Glob|Grep|TaskStop|WebFetch` dropped).
Hooks in `HOOK_EXCLUDE` are skipped with a printed reason; everything else is copied
verbatim, so a guard added to settings.json reaches Codex on the next sync. Two
Codex-only adapters are appended: `hooks/adapters/codex-rewrite.cjs` (rtk +
repowise; Codex only honours `updatedInput` with `permissionDecision: allow`, and
repowise's `ask` is unsupported there) and `hooks/codex-memory-inject.cjs`.

Codex refuses to run a hook until its definition is trusted (`/hooks` in the TUI).
The sync pre-trusts what it generates: Codex's identity hash is sha256 over the
canonical JSON of `{event_name, matcher?, hooks:[normalized handler]}`
(`codex-rs/hooks/src/engine/discovery.rs::hook_hash`, tag rust-v0.153.4), which
`hookHash()` reproduces and `selfTestTrustHash()` proves against a hash Codex wrote
itself that morning. If the scheme ever changes the self-test fails loudly and the
sync says to trust by hand instead of writing hashes that never match.

Two Codex details that bit: `apply_patch` reports `tool_input.command` = the whole
patch, so secret-guard grew an `apply_patch` case (before it hit `default: exit(0)`
and scanned nothing Codex wrote); and `Stop` hooks must print JSON or nothing, never
plain text.

## Memory, agents, prompts

Codex has its own memory store (`~/.codex/memories`, native feature) but it never saw
Claude's: the identity in SOUL.md, the profile and project map in `~/.agents/memory`,
or Claude Code's per-project auto-memory. `codex-memory-inject.cjs` now hands every
Codex session the project map, the named facts, and `MEMORY.md` for the cwd's Claude
project slug, and tells it to save new facts into that same directory. Verified
2026-09-05: `codex exec` asked for the first project slug answered `agent-capsule`.

The five Claude agents become Codex custom agents with the model ladder mapped
(fable -> gpt-6-astra/high, opus -> gpt-5.6-sol/high, sonnet -> gpt-5.6-terra/medium,
haiku -> gpt-5.6-luna/low; slugs from `~/.codex/models_cache.json`), read-only ones
get `sandbox_mode = "read-only"`. `[agents]` in config.toml mirrors the 8-concurrent
cap and routes model-less spawns to the terra tier. Custom commands become
`/prompts:<name>` (Codex's deprecated-but-working custom prompts).

Config additions outside the sync (config.toml, harness-parity block): MCP `mole`
and `treg` mirrored from `~/.claude.json`; DashClaw behaviour-sample env vars.

## What already covered every harness before any of this

The global git pre-commit hook (`core.hooksPath` = `~/.claude/git-hooks`) is
machine-wide, so the staged-secret scan and the manifest gate applied to Codex and
agy commits from day one. Only the in-session guards needed porting.

## Hook dialects

| | Claude Code | Codex CLI | Antigravity CLI |
|---|---|---|---|
| config | `settings.json` | `config.toml` | `~/.gemini/config/hooks.json` |
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

The authoritative list is `HOOK_EXCLUDE` in sync.cjs; each run prints every skipped
hook with its reason.

| Guard | Why |
|---|---|
| `agent-model-guard`, `capability-graph-guard` | Police Claude's model ladder; Codex runs GPT |
| `fable-delegate-guard` | Replaced by its Codex twin `hooks/adapters/codex-delegate-guard.cjs` (astra main loop, gated on the payload `model` field) |
| `opus-handoff-inject` | Opus-specific |
| `guard-canary`, `session-count` | Read Claude's own state; would report Claude's status from another harness |
| `output-secret-watch` | Needs `MessageDisplay`, which only Claude Code has |
| `context-nudge` | Reads the Claude statusline's context percentage |
| DashClaw pretool/posttool/stop/liveness | Codex has its own DashClaw block in config.toml (`--agent-id codex`) |
| `bg-test-guard` (agy only) | agy has no `run_in_background` flag |
| `skill-telemetry`, `sync-main-checkout` | Housekeeping; three agents running the same git sync invites conflicts |

Skills not linked (`SKILL_EXCLUDE`): adversarial-review (Workflow tool), show-me
(Artifact), meditate and harness-health (Claude's own state), team and fable-gpt
(orchestrate Claude/Codex from a Claude session). Skills that also live in
`~/.agents/skills` are not linked into Codex because Codex reads that directory
natively and would list them twice.

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
- **Codex shortens skill descriptions when the list outgrows its budget** (the
  skills doc says so). Since 2026-09-05 every applicable skill is linked anyway:
  Wes asked for identical capabilities, and a shortened description beats an absent
  skill. If a skill stops triggering in Codex, tighten its description first.
- **Codex warns if hooks live in both `hooks.json` and `config.toml`.** They do:
  DashClaw manages a block in `config.toml`. Pre-existing and harmless.
- **New Codex hooks need trusting** (`/hooks` in the TUI) unless a matching
  `[hooks.state]` entry exists; the sync writes those (see Hooks above).
- **A third-party installer can silently break a harness file.** agnostic-ai's
  first-run wrote `{"pre_tool_use": "..."}` into the former Codex hooks.json, a format Codex
  never read; Codex later "repaired" it to `hooks: {}`. first-run.cjs now leaves any
  hooks.json that already carries a `hooks` object alone.
- **context7 over HTTP silently did not load in agy**; the stdio server
  (`npx -y @upstash/context7-mcp@4.0.2`) worked first try. Both harnesses use stdio.

## Verifying the port

```sh
node ~/.claude/tools/harness-sync/sync.cjs --check      # every generated file in sync?
sh   ~/.claude/hooks/adapters/test-agy-adapter.sh       # guards block AND pass?
node ~/.claude/tools/harness-sync/parity.cjs --open     # the rendered picture
codex exec -m gpt-5.6-luna "name the first project slug you were given at session start"   # memory + hooks live?
```

The last line is the end-to-end proof: the answer comes from the injected memory,
and any "hooks need review" warning means the trust entries did not match.

The parity page reads every cell from disk, so it cannot claim a guard is wired
after someone removes it. Verified by deleting one from `~/.codex/config.toml` and
watching the count drop to 9/10 (rule L1: a check never seen failing is not
verified).


## Codex startup cleanup (2026-09-05)

Hook definitions and trust now share config.toml. The generator archives the old
hooks.json instead of deleting it. The unused hooks.generated.json snapshot is
no longer generated or checked; its deletion was blocked by the local policy. The Codex-specific source is
`tools/harness-sync/codex-hooks.json`. All existing governance handlers are retained,
including the TOML-reading liveness probe. Plugin and project trust records survive sync.

Duplicate skill copies are disabled by a generated `[[skills.config]]` region in
config.toml (`# >>> harness-sync skills start`, written by `skillsConfigInCodex` in
sync.cjs, `--check` catches drift): every real directory in `~/.codex/skills` whose
name Codex already reads from `~/.agents/skills` or `~/.claude/skills`, plus the
Codex plugin-tooling skills in `CODEX_SKILL_OFF` (plugin-creator, skill-installer,
review-agent, plugin-management). Parity rule (Wes, 2026-09-05): Codex has every
skill Claude has, so nothing else is hidden. Effect that day: catalog 21.9k → 19.5k
chars, 121 → 115 entries, about 600 tokens per turn. The 21 byte-identical
directories still exist (deletion blocked by policy); they are just disabled.
Bundled system and plugin skill files are left under their upstream owners.

Treg uses `tools/harness-sync/treg-mcp.py`, a stdio bridge built on the already
installed Python MCP SDK. It reads the existing Treg CLI login at startup and
connects only to https://treg.to/mcp/. Tokens are never copied into Codex config.
If the CLI login expires, sign in through Treg and restart the MCP connection.

Verification: fresh Codex app-server MCP discovery returned tools from all 11
integrations, and Treg's balance call succeeded. Sync --check is idempotent.
Rollback copies for this repair are in .codex/tmp/harness-cleanup locally.

Final startup validation: the installed Codex CLI completed a no-tool first turn
with exit 0 and response OK, with no duplicate-hook, skill-shortening, login, or
MCP-startup warnings. Active skill description text fell from 36,740 to 13,441
characters (63.4%); 116 registrations remain active and 22 identical copies are
disabled. Description-only changes covered 122 local skill files, including copies.
All changed frontmatter parsed, all instruction bodies matched their backups,
and all eight independent plugin/project hook trust records were preserved.
