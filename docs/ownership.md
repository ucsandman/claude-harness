# Ownership matrix

One implementation per capability, one writer per generated file, one dependency direction (`core` → `engine` → installed surfaces → client homes; the overlay reads public interfaces, nothing public reads the overlay). This is the table `npm run doctor` enforces. Dated 2026-09-19, the day of the consolidation ([migration-2026-09.md](migration-2026-09.md)).

| Capability | The one implementation | Generated outputs and their single writer | Private part (overlay) |
|---|---|---|---|
| Portable rules (the working agreement) | `core/rules/global-rules.md` + `core/rules/modules/*.md` | `~/.claude/agnostic-rules.md` by `engine/sync/sync.cjs` (`npm run sync`, primary client only); every other client's rules file by `engine/harness` (`npm run port`) | `overlay/profile.md` |
| `CLAUDE.md` | assembled, never edited | `~/.claude/CLAUDE.md` by `engine/sync/claude-md.cjs`: `@import` of the rules, the profile inside `<!-- agnostic:profile -->`, preserved foreign marker blocks (declick) | the profile text |
| `AGENTS.md`, `GEMINI.md`, `.cursor/rules`, 16 more | rendered from the capture | by `npm run port` (`core/port.json` says what each client drops, `npm run explain` says why) | none |
| Identity | `~/.claude/SOUL.md` (the meditation ladder's top rung) | inlined into other clients by the port | the file itself |
| Memory | `~/.claude/projects/<slug>/memory/` content | index rows in `MEMORY.md` (written by sessions under the rules in `packages/markdown-agent-memory`) | all of it |
| Context graph | `engine/context/` (select, resolve, pack, render) + hook `engine/hooks/context-graph.cjs` | the ledger `~/.claude/logs/context-graph.jsonl` | `overlay/context-graph.json` (roots, budgets) |
| Skills | the skills library, its own repository at `~/.claude/skills` | linked into every client by the port | private skills in the same library |
| Subagents | `agents/*.md` | `~/.claude/agents` is a link; other clients by the port | none |
| Slash commands | `~/.claude/commands/*.md` (private overlay) | other clients by the port | all of them |
| Guard hooks | `engine/hooks/*.cjs` (+ `lib/`, `tests/`, `adapters/`) | `~/.claude/hooks` is a link; the frozen set is `tools/gates/gate-manifest.lock.json` (`gates.cjs --lock`) | `settings.json` registrations; extra roots in `overlay/gates.json` |
| Mods (function hooks) | `engine/mods/{harness-runtime,harness-mods}` | `~/.claude/mods` is a link; heartbeat and events under `~/.claude/mods/state/` | `mods-config.json` modes |
| MCP servers, permissions | `~/.claude.json`, `settings.json` (Claude Code's own) | other clients by the port (a secret-shaped header is never copied) | all of it |
| Model routing | `core/rules/modules/delegation-and-model-routing.md` + `engine/hooks/agent-model-guard.cjs`, `subagent-budget-guard.cjs` | none | none |
| Context health, handoffs | `engine/hooks/{compaction-ledger,precompact-extract,opus-handoff-inject}.cjs`; the handoff package is `context-handoff-bundle` (its own repository) | `~/.claude/state/*` | none |
| Agent comms | `~/clawd/agent-comms` (its own repository, private data) + module `parallel-agents-inbox` | none | the inbox |
| Harvesting, distillation | `engine/harvest`, `engine/distill`, `engine/ingest` (experimental; the live ladder is the private meditation corpus) | `storage/*` (gitignored) | `~/.claude/meditations/` |
| Session startup | `settings.json` `SessionStart` hooks (public scripts, private registration) | none | the registration |
| Scheduled jobs | `jobs/` + `jobs/install.cjs` | Task Scheduler actions (`install.cjs --apply`) | private jobs under `~/.claude/scripts/` |
| Operator tools | `tools/<name>/` | pages and caches under the Claude home or gitignored beside the tool | none |
| Docs | `docs/` (budgeted by `tools/gates/budgets.json`) | `docs/targets.md` by `npm run docs:targets` | `~/.claude/docs/` (machine facts, private notes) |
| Tests | `engine/tests/`, `engine/hooks/tests/`, `engine/mods/*/tests/`, `tools/*/tests/` | none | none |
| Examples | `examples/installed-harness/` | none | none |

## What the doctor checks against this table

`links` (five surfaces bound), `hook-wiring` (every registered hook resolves into this repository), `rules-drift` (each writer checks its own outputs), `claude-md` (one writer, allowed markers), `old-refs` (no retired repository named), `private-boundary` (no account home path in public code), `data-files` (no transcript-derived data tracked), `linked-leftovers`, `orphan-hooks`, `unexpected-links`, `context-graph`, `deps`, `jobs`.
