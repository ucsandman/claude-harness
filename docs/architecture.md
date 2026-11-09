# Architecture

## The three places (since 2026-09-19)

| Place | Role | Repository |
|---|---|---|
| this repository | the operating system: `core/` (rules, registry, policy), `engine/` (harness port, context graph, sync, setup, doctor, hooks, Mods), `agents/`, `workflows/`, `tools/`, `jobs/`, `docs/` | public |
| the overlay (`~/.claude/overlay/` and the rest of the Claude home you track) | the user profile: `profile.md` (private section of `CLAUDE.md`), `context-graph.json` (context roots), `gates.json` (extra frozen files), memory, meditations, private jobs, `settings.json` | private, yours |
| the installed runtime (`~/.claude` as the client sees it) | links into this repository for hooks, tools, mods, agents and workflows; generated `agnostic-rules.md` and `CLAUDE.md`; state under `logs/`, `state/`, `mods/state/` | not a codebase |

Dependency direction is one way: `core` → `engine` → the installed surfaces → the client homes. The overlay is read only through three files the engine names ([private-overlay.md](private-overlay.md)); `labs/` may depend on `engine/`, never the reverse. Every generated file has one writer ([ownership.md](ownership.md)), and `npm run doctor` fails on a second one, on a retired path, on the author's home path in public code, and on transcript-derived data in the tree.


One harness, captured from the client you use, applied to every other client.
Zero-dependency Node; every engine runs on the standard library.

```
                 the client you use                       harness/ (client-neutral bundle)
   ~/.claude  CLAUDE.md settings.json skills/ agents/    rules.md identity.md hooks.json
   ~/.codex   AGENTS.md config.toml  skills/ agents/ ──▶ mcp.json agents/ commands/
                                          capture        skills.json permissions.json
                                                                   │ apply
      ┌────────────┬────────────┬───────────┬──────────┬───────────┴──────────┬────────────┐
   ~/.codex     ~/.gemini    ~/.cursor   ~/.claude   ~/.windsurf ...     ~/.hermes    storage/compiled
   AGENTS.md    GEMINI.md    rules.mdc   agnostic-   global_rules         agent_       system_prompt.md
   config.toml  settings.json hooks.json rules.md    mcp_config           system.md
   agents/      commands/    agents/     settings.json
   prompts/     skills/      commands/   .claude.json
   skills/                   skills/     agents/ commands/
      │            │            │
      └── hooks ───┴────────────┘   engine/hooks/shim.cjs translates each client's
                                     hook payload to the Claude dialect and back, so
                                     the same guard scripts run everywhere
                                                  │
                     engine/harvest/harvest.cjs ← error logs, corrections, CLAUDE.md lessons
                                                  │
                     storage/candidates.jsonl → engine/distill/distill.cjs (promotion ladder)
                                                  │
                     tools/dashboard (human approves) → writes back into the rules
```

## Port engine (`engine/harness/`)

The contract every adapter follows is `engine/harness/README.md`. In short:

| Module | Role |
|---|---|
| `capture.cjs` | Picks the source client (`core/port.json` or auto-detect), runs `sources/<client>.cjs`, saves the bundle under `harness/`. |
| `apply.cjs` | For every installed target that is not the source, runs `targets/<adapter>.cjs` component by component (rules, identity, hooks, skills, agents, commands, mcp, permissions) through a guarded writer, saves `storage/harness-state.json` (ownership) and `storage/harness-report.json` (what happened, what was dropped and why). |
| `status.cjs` | Re-runs apply in check mode and renders the per-target, per-component matrix as a terminal table or a standalone HTML page. |
| `cli.cjs` | `capture`, `apply`, `port` (both), `status`, `explain`. |
| `bundle.cjs` | Load, save and validate the bundle; refuses to save a secret-looking value. |
| `toml.cjs` | A small TOML reader for the subset Codex's config uses (tables, arrays of tables, strings, arrays, inline tables). Writing goes through managed regions, never a serializer. |
| `common.cjs` | Guarded writes with backups and hand-edit detection, directory links, managed regions, frontmatter, secret detection. |
| `sources/` | `claude.cjs`, `codex.cjs`: read one client into the bundle. |
| `targets/` | `codex.cjs`, `claude.cjs`, `gemini.cjs`, `agy.cjs`, `cursor.cjs`, and `generic.cjs` for every rules-plus-skills-plus-MCP client. |

`core/templates/targets.json` is the registry: every client's home, rules
file, hook config, skills dir, agents dir, commands dir and MCP file, plus
which adapter renders it. `docs/targets.md` is generated from it and CI fails
when it is stale.

### Authored rules (`engine/sync/sync.cjs`)

If you prefer to author your working agreement in this repo instead of in a
client, `core/rules/global-rules.md` and `core/traits/traits.md` are compiled
by `npm run sync` into the primary client's rules surface (for Claude Code,
`~/.claude/agnostic-rules.md`, pulled into `CLAUDE.md` by an `@import` line).
The next `npm run port` then carries it everywhere. Sync uses the same
guarded writer semantics: backup before overwrite, hand edits are skipped
unless `--force`, `--check` exits 1 when stale.

## Context graph (`engine/context/`)

Situational context as modules with declared dependencies: markdown files
whose frontmatter carries `context: { requires, suggests, triggers, ... }`,
plus `[[wikilinks]]` as soft edges. `select` picks targets from deterministic
signals (prompt keywords, cwd and touched-file globs, repo, tool, subagent
type); `resolve` returns the dependency closure in prerequisite order (cycles
detected, closure bounded); `pack` fits it into a hard budget with session
dedup by content hash; `render` makes every module say why it is there. Roots
are the trust allowlist (harness, user, repo), and a repo-trust module can
never pull harness or user context along. A client wires it with one hook
(Claude Code: `~/.claude/hooks/context-graph.cjs`, ported to the other clients
like every other hook). Contract and CLI: `engine/context/README.md`.

## Hooks (`engine/hooks/`)

| File | Role |
|---|---|
| `shim.cjs` | Runs a Claude-dialect hook under Cursor, Gemini CLI or Antigravity: translates the payload in, chains several guards (`++`), first deny wins, translates the decision out. Fails open so a broken guard never wedges the client. |
| `universal-adapter.cjs` | Normalises Claude Code / Codex / Antigravity / Cursor / generic payloads into one `{client, event, toolName, command, targetFile}` object for the shipped guards below, and serialises the decision in each dialect. |
| `secret-guard.cjs` | Denies tool calls that touch secret paths. Patterns come from `guards.json`; a built-in fallback list applies if that file is unreadable (fail closed). |
| `dashclaw-guard.cjs` | Scores the call (`calculateLocalRisk`) from `guards.json`. Below the query threshold: allow. At or above it: ask DashClaw if configured, else apply the local verdict. At or above the hard-block threshold with no reachable approver: deny. |
| `fable-delegate-guard.cjs` | Claude Code only. Briefs a Fable main loop once with measured delegation economics and logs large edits for `--report`. Denies nothing. |
| `capability-graph-guard.cjs` | Claude Code only. Enforces the subagent capability graph (Fable -> Opus/Sonnet/Haiku, Opus -> Sonnet/Haiku, Sonnet -> Haiku). Kill switch: `CAPABILITY_GRAPH_GUARD=off`. |
| `correction-tracker.cjs` | Appends user corrections to `storage/corrections.jsonl` for the harvester. |
| `dashclaw-setup.cjs` | Writes `storage/dashclaw-config.json` from `DASHCLAW_*` env vars. |

The shipped guards are installed into the primary client by
`engine/setup/first-run.cjs`; the port then carries them to the others like
any other hook.

## Harvest and distill

`engine/harvest/harvest.cjs` scans local agent logs (`~/.claude/error-log`,
`~/.claude/corrections.jsonl`, `storage/corrections.jsonl`, meditation
candidates, the learned-rules section of the rules) and writes deduplicated
records to `storage/candidates.jsonl`. `engine/distill/distill.cjs` runs the
promotion ladder and writes `storage/distill-digest.json` and
`storage/distill-PROPOSAL.md`:

| Tier | Meaning | Automated? |
|---|---|---|
| 0 Observation | a raw sighting | yes (harvest) |
| 1 Fact | repo-specific, repeated | yes: promoted by the distiller |
| 2 Rule | seen on 3+ distinct days; capped at 5 core rules | proposed by the distiller, **written only when a human approves** in the dashboard (or `--approve <id>`) |
| 3 Trait | a disposition in `core/traits/traits.md` | no: hand-curated |
| E Example | failure converted to a few-shot fixture in `core/examples/` | yes (`prune.cjs`) |

The lifecycle and its legal moves live in `engine/distill/ladder.cjs`
(states observation, fact, proposed, promoted, trait, dropped, tombstoned);
every tier writer calls `assertTransition`, and a refused move is HTTP 409 from
the dashboard or exit 2 from `distill.cjs --approve`.

`engine/ingest/merge.cjs` pulls lessons from project-level `CLAUDE.md` /
`AGENTS.md` / `GEMINI.md` files back into the rules.

## Skills

`engine/skills/consolidate.cjs` copies skills found in each client's skills
directory into `skills/definitions/` (gitignored) and writes
`storage/skills-manifest.json`; `engine/skills/recommend.cjs` scores skills
per project. The port itself never copies a skill: it links each one from the
source client so an edit is live everywhere.

## Human surfaces (`tools/`)

All servers bind `127.0.0.1`. Mutating routes are `POST`, require the
per-process token injected into the page, and reject non-loopback origins.

| Tool | Port | What |
|---|---|---|
| `tools/sync/parity` | 7845 | The port status page: per-client, per-component matrix, dropped items with reasons, a "Port now" button. |
| `tools/dashboard` | 7842 | Command center: candidates, rules, skills matrix, project recommendations, routines, DashClaw settings, guard simulator. |
| `tools/recall` | 7844 | Search rules, memory files and decisions. |

Ports are defaults, not guarantees: on collision a server walks up to the next
free port (10 tries) and logs the URL it bound.

## Storage layout

| Path | Tracked | Written by |
|---|---|---|
| `harness/` | no | capture (the bundle; holds machine paths) |
| `storage/harness-state.json`, `harness-report.json`, `harness-status.html` | no | apply, status |
| `storage/backups/`, `sync-state.json` | no | apply, sync |
| `storage/candidates.jsonl`, `distill-digest.json`, `distill-PROPOSAL.md`, `corrections.jsonl` | no | harvest, distill, correction-tracker |
| `storage/deleted-candidates.json`, `prune-report.json`, `skills-manifest.json`, `skills-config.json` | no | harvest / prune / consolidate / dashboard |
| `storage/dashclaw-config.json`, `harness-installed.json` | no | dashclaw-setup, first-run |
| `storage/compiled/` | no | apply (the generic system prompt target) |
| `skills/definitions/` | no | consolidate |
| `core/**` | yes | you (and approved promotions) |
