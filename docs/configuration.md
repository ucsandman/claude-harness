# Configuration

## Files you edit

| File | Purpose |
|---|---|
| `core/port.json` | Port policy: the source client (`auto`, `claude`, `codex`), which targets receive it (`installed`, `all`, or a list), hooks / skills / MCP servers deliberately not ported (each with a reason), target-only extra hooks, the model ladder per target. |
| `core/templates/targets.json` | The client registry: home, rules file, hook config, skills dir, agents dir, commands dir, MCP file and adapter per client. `npm run docs:targets` after editing. |
| `core/safety/guards.json` | Secret paths, blocked commands, hard-stop patterns, DashClaw thresholds. Read by the Node hooks and the dashboard simulator. |
| `core/rules/global-rules.md`, `core/traits/traits.md` | Optional. A working agreement authored here instead of in a client; `npm run sync` compiles it into the primary client. |
| `core/examples/` | Few-shot fixtures produced by `prune.cjs`. |

The source of truth for everything else is the client you use. Edit your
`CLAUDE.md`, `settings.json`, skills, agents, commands and MCP servers there,
then `npm run port`.

## Commands

| Command | What |
|---|---|
| `npm run port` | Capture the source client, apply to every other installed client. The everyday command. |
| `npm run port:check` | Same, writes nothing, exits 1 if any generated file drifted. Put it in a scheduled job or a shell prompt. |
| `npm run capture` | Only read the source into `harness/`. |
| `npm run apply` | Only render `harness/` into the targets. |
| `npm run status` / `status:open` | Per-client, per-component matrix in the terminal, or as a page. |
| `npm run explain` | Every hook, skill, agent, server or permission that was not ported, with its reason. |
| `npm run parity` | The status page as a local server with a "Port now" button. |
| `npm run sync` / `sync:check` | Compile `core/rules` into the primary client (authoring mode). |
| `npm run setup:default` | First-run onboarding: harvest, consolidate skills, port, install the shipped guards into the primary client. |
| `npm run launch` | First-run check, port check, engine tests, then the command center. |
| `npm run harvest`, `distill`, `merge`, `dashboard`, `recall`, `skills:*`, `dashclaw:*` | The rule-learning loop and its surfaces. |

CLI flags (`node engine/harness/cli.cjs <command> [flags]`): `--from <id>`,
`--to <id,id>`, `--check`, `--dry-run`, `--force`, `--home <dir>`,
`--bundle <dir>`, `--storage <dir>`, `--json`, `--html`, `--open`.

## Environment variables

Nothing loads `.env` for you; export variables in your shell or CI.
`.env.example` lists every variable with a comment. Summary:

| Variable | Used by | Default |
|---|---|---|
| `DASHCLAW_BASE_URL`, `DASHCLAW_API_KEY`, `DASHCLAW_AGENT_ID`, `DASHCLAW_AGENT_NAME` | `engine/hooks/dashclaw-setup.cjs` | unset; governance stays local |
| `FABLE_DELEGATE_GUARD` | `engine/hooks/fable-delegate-guard.cjs` | unset; `off` silences the briefing and the log |
| `CAPABILITY_GRAPH_GUARD` | `engine/hooks/capability-graph-guard.cjs` | unset; `off` disables the guard |
| `PORT` | dashboard | 7842 (next free port if taken) |
| `RECALL_PORT` | recall | 7844 |
| `PARITY_PORT` | parity / status page | 7845 |
| `AGNOSTIC_STORAGE` | harvest / distill / prune | `<repo>/storage` |
| `AGNOSTIC_EXAMPLES_DIR` | prune | `<repo>/core/examples` |
| `AGNOSTIC_PROJECTS_DIR` | skill recommender, dashboard Projects tab | `C:\Projects` on Windows, `~/Projects` elsewhere |

MCP credentials: the port replaces a secret-looking env value with `${NAME}`
and tells you to export `NAME`. Each client then reads it from its own
environment at launch.

## The bundle (`harness/`)

Gitignored by default because it holds absolute paths from this machine. To
version your harness, remove the `harness/` line from `.gitignore`; the bundle
is plain markdown and JSON and never contains a secret (the save refuses one).
Shape: `docs/porting.md` and `engine/harness/README.md`.

## DashClaw (optional)

Set `DASHCLAW_BASE_URL` (and `DASHCLAW_API_KEY` for a remote instance) and run
`npm run dashclaw:setup`. The guard then asks DashClaw for a decision on any
call scoring at or above `guards.json -> dashclaw.defaultRiskThreshold` (50)
and holds hard stops (>= `hardBlockRiskThreshold`, 90) for remote approval.
Opt out at any time: dashboard -> Governed Decisions -> Settings -> Opt Out, or
set `"active": false` in `storage/dashclaw-config.json`. When opted out the
harness makes no network requests for governance.

## Scheduled jobs (Windows)

`jobs/port-daily.ps1` runs `npm run port` and the guard probe (the `HarnessParitySync` task; `node jobs/install.cjs --apply` registers it); `jobs/daily-distill.ps1` runs
harvest + distill and logs to `storage/daily-distill.log` (the `DailyDistill`
task, 07:00); `jobs/opening-move-digest.cjs` writes the Opening Move digest and
runs its allowlisted repairs (the `OpeningMoveDigest` task, 06:50). Register them with
Task Scheduler (for example nightly, after whatever job edits your primary
client's rules) or run them by hand. On other platforms call the same `node`
commands from cron. Every job that leaves an artifact declares `expects: {path, maxAgeH}`
in `jobs/install.cjs`; `npm run doctor` fails when that artifact is stale
([opening-move.md](opening-move.md)).

## Uninstall

The port writes only inside this repo's `harness/`, `storage/` and
`skills/definitions/`, plus the surfaces listed per client in
[`targets.md`](targets.md), each backed up to
`storage/backups/<client>-<file>-<timestamp>.bak` before every overwrite.

1. Restore a client's rules file from the newest `.bak` for it, or delete the
   generated file (its first line says `GENERATED by agnostic-ai`).
2. Remove the managed regions (`# >>> agnostic-ai ... start` to
   `# <<< agnostic-ai ... end`) from `config.toml`, and the hook groups and MCP
   servers the port added to `settings.json`, `hooks.json`, `mcp.json` and
   `.claude.json` (`storage/harness-state.json` lists exactly which ones).
3. Delete the skill links in each client's skills dir (links only; real
   directories were never touched) and the generated agents, prompts and
   commands (`GENERATED by agnostic-ai` in their first line).
4. Delete this repo's `harness/`, `storage/` and `skills/definitions/`.
