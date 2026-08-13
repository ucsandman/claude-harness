# claude-harness

The actual Claude Code setup I run every day on Windows 11, mirrored public.
Not a starter kit someone designed in an afternoon. This grew rule by rule out
of real incidents, and most of it exists because something broke first.

Three examples of what that means:

- `hooks/process-kill-guard.cjs` exists because a subagent cleaned up its test
  window with `Stop-Process -Name notepad` and killed a real Notepad session
  with about 40 tabs of unsaved work. Name-based process kills are now blocked
  at the tool layer. PID-based kills still work.
- `hooks/agent-model-guard.cjs` exists because one workflow spawned 110 agents
  on the most expensive model through inherited defaults and burned a full
  5-hour usage window. Every agent spawn now requires an explicit model, and
  the expensive tier is capped per session.
- `git-hooks/pre-commit` runs `hooks/secret-guard.cjs` over every staged file
  in every repo on the machine, whatever the language, because keys were once
  found sitting in plaintext on disk.

## Layout

| Path | What it is |
|---|---|
| `CLAUDE.md` | The global working agreement. Loaded into every session. The core of the whole thing. |
| `SOUL.md` | Who the agent is. Read before CLAUDE.md. **Template here**, see below. |
| `RTK.md` | Notes for rtk, a Rust CLI proxy that compresses Bash output 60 to 90 percent via a hook. |
| `settings.json` | Hook wiring, permissions, env. Secrets live in a separate untracked file it points at. |
| `hooks/` | PreToolUse and lifecycle guards: secret-guard, process-kill-guard, agent-model-guard, manifest-gate, scope-lock, and friends. |
| `git-hooks/` | The global pre-commit chain (`core.hooksPath`). Secret scan, manifest gate, Python lint gate. |
| `tools/` | Small zero-dependency tools the agent uses: spend ledger, memory search, repo status board, scheduled-job health, secrets-wiring checkup, desktop eye, TTS, process ledger, check-breaker, session fleet monitor. Each has its own README. |
| `scripts/` | Scheduled jobs: nightly meditation, morning fleet briefing, deploy sentinel, harness health audit. |
| `agents/` | Subagent definitions with explicit model routing (cheap scout, mid implementer, security reviewer). |
| `docs/` | The reference docs CLAUDE.md points at, plus `reddit-claude-setup-share.md`, a guided tour written to be pasted into Claude Code and adapted to your project. |
| `meditations/` | The nightly reflection loop and the promotion ladder. **Templates here**, see below. |

## The meditation ladder

The part people ask about most. A scheduled session runs every morning,
reflects on recent work, and appends dated observations. Ideas climb a ladder:
observation, then fact (memory), then rule (CLAUDE.md), then trait (SOUL.md).
Each rung has explicit graduation gates, every promotion cites the dated
evidence that earned it, and the ladder runs both ways: rules contradicted by
evidence get superseded, not defended. The design goal is that refusing a
promotion is the normal outcome. The gates are in
`meditations/MEDITATIONS.md`.

## What is templated

`SOUL.md` and everything under `meditations/` are structural templates in this
mirror. The real files accumulate personal and business context that stays
private. The mechanism, the gates, and the write rails are all here unchanged.

## What is not here

- `projects/` (the agent's memory store). Private, stays on the machine.
- `skills/`. Personal skill definitions, some of them voice and identity
  material.
- `.secrets.env` and anything else untracked. The repo never contained
  credentials, and this mirror was swept file by file and through full history
  patterns before publishing.

## Using it

Do not clone this expecting a turnkey install. Paths are Windows and specific
to one machine. The useful move is stealing pieces: a hook, a gate, a tool,
the ladder. `docs/reddit-claude-setup-share.md` is written exactly for that,
with a "steal this pattern" line per item.

## License

MIT.
