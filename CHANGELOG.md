# Changelog

## Unreleased

### 2026-11-09: cronwatch classifies running tasks correctly and its verdict can clear

- `tools/cronwatch/cronwatch.cjs`: the Task Scheduler status constants were
  off by 512 (266497 for 0x41301; the value is 267009), so every task mid-run
  rendered as a red `error 0x41301`; fixed, and `State=Running` now
  classifies as RUNNING, which also covers an IgnoreNew daemon whose
  keepalive reports 0x800710E0 while the old instance runs. The exit verdict
  (`verdictTasks`) no longer counts Windows' own tasks under `\Microsoft\` or
  the board itself, so `CronwatchDaily` exit 1 means a failed task of yours;
  stderr prints `N of M scheduled task(s) FAILED`. README matches the code.
  Probe: `tools/cronwatch/tests/cronwatch-probe.cjs` (8 cases).

### 2026-11-09: Opening Move, the session brief, the Next ledger, the nightly digest and the Today tab

- `engine/hooks/opening-move.cjs` (new, SessionStart + the prompt dispatcher):
  every cli session opens with one `systemMessage` line and a brief built in
  under 200 ms from git, the repo's ring of recent sessions, the markers and
  `digest.json`: what changed since the last session, the reds, and one NEXT
  with an owner (`me`, `you`, `wait <date>`, `none`) chosen by a 10-rung
  ladder; "go", "continue", "next", "resume" or a greeting binds the `me`
  NEXT to that prompt. The hard-stop filter rewrites deploy/publish/send/
  delete-class text to `prepare <x>; <x> stays yours` and fails closed on
  path-shaped tokens.
- `engine/hooks/turn-close.cjs` (new, Stop) replaces the dead
  `forced-verify-stop-gate.cjs`: parses the reply's closing `Next (<owner>):`
  line into the repo's `next`, records whether the turn edited code and
  whether a check passed afterwards (`off | shadow | enforce`; shadow logs,
  enforce blocks once per human prompt), and writes one `finals.jsonl` row
  per human-prompt Stop.
- `jobs/opening-move-digest.cjs` (new; `OpeningMoveDigest` 06:50, or a
  detached refresh behind `digest.lock` when a brief finds the digest over
  60 min old): eight sources with counts (doctor, guard canary, job
  contracts, gitradar repos, ci, hook errors, learning, fixture), three
  allowlisted T0 repairs (rules-drift, links, install-differs) that never
  run under a live session or from a harness session, and a 5-fault fixture
  that proves the instruments on every run.
- `jobs/install.cjs`: every job that leaves an artifact declares `expects:
  {path, maxAgeH, resultNote?}`; `npm run doctor` (`jobs`) fails on a stale
  or missing artifact. First real positive: `NightlyMeditation`, dark 51
  days under a path-only check, fixed in discovery-loop and seen running
  again on 2026-11-09.
- `engine/hooks/guard-canary.ps1`: a red status replays for 60 min unless an
  input changed; frozen-drift lines and hook-target misses are kept apart.
- `tools/dashboard`: the command center opens on a Today tab (digest head
  line, reds with [Mute 7 days], Fixed for you, NEXT kinds with Demote and
  Restore, verify-gate precision, Next-line coverage, the `config.json`
  toggles) over `GET /api/opening-move` and `POST mute | settings | refresh`
  behind the session header, a loopback Origin and a loopback Host. A
  guard-class red never mutes; a key naming an `Object.prototype` member is
  400; a POST on a file it cannot parse is 409.
- `core/rules/global-rules.md`: ADHD rule 3 ends every reply with `Next
  (me|you|wait YYYY-MM-DD|none): …`; the "Opening move" How to Work bullet.
- Docs: `docs/opening-move.md` (new, the reference), `docs/configuration.md`
  (the jobs and their contracts), `docs/guards.md`, README, `docs/ERRORS.md`
  (three entries). Probes: `opening-move-probe.cjs` (22 cases, 39 negatives,
  `--stub`, `--leaky`), `turn-close-probe.cjs` (20), `opening-move-digest-
  probe.cjs` (14), `tools/dashboard/tests/today-probe.cjs` (13); reg-hooks 81.

### 2026-11-08: the distillation ladder refuses moves it has no edge for

- `engine/distill/ladder.cjs` (new): the candidate lifecycle as one table
  (observation, fact, proposed, promoted, trait, dropped, tombstoned) with a
  3-distinct-day gate into proposed and promoted. State is derived from the
  stored tier, status and promoted flag; no field is added or rewritten.
- Closed edges: approve from observation, dropped or trait, or under 3 days
  (it used to append an L-rule from any record); the distiller lifting or
  proposing dropped rows and resurrecting tombstoned ids from
  `corrections.jsonl`; arbitrary tier edits (promoted demotion, any -> trait,
  out-of-range tiers). Same-tier saves stay legal in every state.
- Contract: `POST /api/candidate/update` and `/approve` answer 409
  `{error:'illegal_transition', current, requested, allowed, message}`;
  `distill.cjs --approve` prints the refusal plus a JSON line and exits 2
  (other failures stay exit 1). Candidate reads gain `state`, `state_label`
  and `allowed_next`; the dashboard builds its tier options and the Approve
  button from `allowed_next`. `engine/tests/reg-ladder.cjs` pins it.

### 2026-11-08: the fan-out ceiling regex could never see `const MAX_AGENTS`

- `engine/hooks/agent-model-guard.cjs`: the `\bMAX_AGENTS\s*=` alternative
  held a literal 0x08 byte where `\b` was meant, so only a numeric
  `// MAX_AGENTS: N` comment passed and every saved workflow with a prose
  comment plus a const (tournament) was denied. Byte replaced; the
  `fanout-probe` gains the const-form case, which the previous guard fails.
- `workflows/*.js`: every agent prompt now opens with `# EST: <n> calls, <n>
  files` (the subagent-budget guard denied all twelve tournament candidates
  without it); `adversarial-review` and `understand` declare MAX_AGENTS as
  arithmetic with caps (6 dimensions, PER_DIM findings sized to the ceiling,
  24 readers) and log what they drop.
- `tools/gates/gates.cjs`: `hook-wiring` reads `~/.claude/settings.json` when
  the repo root has none, so the gate passes from the harness repo again (44
  targets checked) instead of failing on "settings.json not found".
- `docs/ERRORS.md`: the entry.

### 2026-09-29: the routing Mod prices a spawn's arrival, not its whole run

- `engine/mods/harness-mods/hooks/lib/budget.mjs`: the first `ModelStep` is
  always the spawn's overhead. `tool.call` counts the call before its step
  arrives, so the old `!a.calls` capture never fired and `settle()` stored the
  whole run as overhead (0 of 34 runs captured; sonnet-implementer priced at
  487,680 to arrive, opus-owner at ~2.2M). `settle()` no longer falls back to
  the total, and `OVERHEAD_VERSION = 2` discards stored overhead samples from
  before the fix, so priors refit from the lean/full constants.
- New test replays the live event order (`tests/lib.test.mjs`, 12/12). Record
  in `docs/ERRORS.md`.

### 2026-09-26: the context-budget nudge is gone

- `engine/hooks/context-nudge.cjs` and the `contextNudge` Mod guard removed
  (Wes). Its percent was measured against the auto-compact window while the
  statusline shows the model window, so "81%" and "42%" described the same
  session. Out of the prompt chain, `mods-config.json`, the canary, the
  modes table, `HARNESS_MOD_CONTEXT_NUDGE` and `core/port.json`.

### 2026-09-19: claude-harness is the same repository again; README for the whole tree

- `ucsandman/claude-harness` (24 stars) is a push mirror of `master` instead of
  an archive: its history was joined as an ancestor, `git push claude-harness`
  fast-forwards it, `npm run doctor` fails on `mirror-current` when it is
  behind. `.github/FUNDING.yml` came along.
- README rewritten to describe every directory, hook, module, tool, job, agent
  and workflow from source, with a contents list and the doctor's checks. Its
  word ceiling in `tools/gates/budgets.json` rose from 2200 to 4500 for that.

### 2026-09-19: one process for the prompt hooks; wake-up streaks stopped

- `engine/hooks/prompt-dispatch.cjs` is the only UserPromptSubmit command: it
  runs the nine prompt hooks in-process (118 ms for the chain, one node start
  instead of eight) and merges their answers. Eight spawns at 5 s each had
  timed out on every prompt with node startup at 2.6 s under load.
- `engine/hooks/wakeup-guard.cjs`: from the third consecutive Monitor /
  ScheduleWakeup / task-notification turn with no human prompt between, the
  model is told to answer nothing, stop the stalled task, re-arm at >= 1200 s.
  `context-graph.cjs` no longer loads modules for a `<task-notification>`.
- `context-nudge.py` ported to `context-nudge.cjs` (the python start alone was
  the 5 s). Doctor check `prompt-hooks`; `first-run.cjs` installs the
  dispatcher; probe `engine/hooks/tests/prompt-dispatch-probe.cjs` (12 checks).

### 2026-09-19: slow sessions were process spawns, not the model

- `tools/hook-latency/`: hookpar, hooktime, usage, cachetrace, memmap. Wall
  clock per event, per hook, fixed context and cache losses per transcript,
  RAM and spawn latency per machine. `docs/hook-latency.md` has the pass.
- `tools/bash-noprofile/`: a Git Bash shim for Claude Code's Bash tool on
  Windows (`--noprofile --norc`, explicit std handles, kill-on-close job).
  A Bash tool call in a fresh session went from 31.6 s to 4.2 s on the box
  that motivated it. Built, not tracked; wired via `CLAUDE_CODE_GIT_BASH_PATH`.

### 2026-09-19: one repository for the harness

- The harness that lived across `claude-config`, the `claude-harness` mirror, `claude-mods-rnd`, `markdown-agent-memory` and `claude-commands` now has one public home here and one private overlay: `engine/hooks` (the guard hooks, their probes and Codex adapters), `engine/mods` (the function-hook plugins), `agents/`, `workflows/`, `tools/` (19 operator tools), `jobs/` (with `install.cjs` for Task Scheduler), `packages/markdown-agent-memory`, `labs/` (claude-mods research, tokflow, procledger, detached-builder), `examples/installed-harness`, 16 docs. Every moved file: `docs/PROVENANCE.md`; the record: `docs/migration-2026-09.md`; the matrix: `docs/ownership.md`.
- `npm run sync` now compiles the rules, binds `~/.claude/{hooks,tools,mods,agents,workflows}` as links into this checkout (`engine/setup/link.cjs`, originals moved aside) and assembles `CLAUDE.md` from the rules import plus `overlay/profile.md` (`engine/sync/claude-md.cjs`, the file's one writer). `npm run setup` ends with `port` and `doctor`; a clean clone against an empty home ends green.
- `npm run doctor` (`engine/doctor/doctor.cjs`): thirteen checks, each with the count it processed.
- `engine/context/config.cjs` resolves relative roots against the config file's real directory (through a link the rules root loaded nothing).
- Mods resolve the Claude home through `$.env` on their first event; the hooks worker has no Node globals.
- `sync` is primary-client-only; `port` is the single writer of every other client's rules file. `docs/parity.md` rewritten for the engine port; the retired Gemini shim, `harness-sync`, `mirror-sync` and `sync-targets.ps1` are gone.
- No tracked file carries the author's home path; transcript-derived experiment data is untracked and ignored.

- **Context graph: command signals, suggest, dynamic-recall absorbed** (2026-09-19).
  `triggers.commands` makes a shell command a selection signal (substring, +3), so the
  three tips the Claude Code hook `dynamic-recall.cjs` used to inject are now modules
  (`core/rules/modules/seo-floor.md`, `secrets-non-negotiable.md`, `harness-integrity.md`)
  and that hook is retired. `cli.cjs suggest --days N` reads the ledger and prints the exact
  `suggests:` line for module pairs co-loaded 3+ times across 2+ sessions with no edge yet
  (the recurrence gate; signals over 30 days count half). 42 checks.
- **Semantic context graph** (`engine/context/`, 2026-09-19). Durable context
  as modules with declared dependencies: `context:` frontmatter (`requires`,
  `suggests`, `triggers`, `scope`, `clients`, `priority`, `stale_after`,
  `sensitivity`, `section`) plus `[[wikilinks]]` as soft edges. Deterministic
  resolution (closure, cycle detection, topological order, bounded depth and
  size), budget packing with session dedup, a renderer that names why each
  module loaded, and a CLI (`resolve`, `explain`, `impact`, `graph`, `select`,
  `bundle`, `show`, `list`, `report`). Trust boundary: roots are the allowlist,
  symlink escapes are excluded, repo-trust modules cannot reach outside their
  root, private modules never join a repo-trust bundle, secret shapes are
  dropped. `engine/tests/reg-context.cjs` (39 checks; `--break` is the
  negative control) joins `npm test`. Four sections of `core/rules/global-rules.md`
  (Delegation and Model Routing, Parallel Agents and the Inbox, the push
  destinations, the memory write rules) became modules in `core/rules/modules/`
  with two-line pointers left in place; the compiled Claude rules file dropped
  from 22.2 KB to 17.2 KB.

- **The port engine is embeddable.** `engine/harness/index.cjs` is the library
  entry; `common.configure({ brand, secretPatterns, shimPath, importRoots })`
  lets a host own the ownership claim, the secret patterns, the hook shim path
  and the import roots; `loadRegistry(home, { targets })`, `capture({ registry,
  sources })`, `apply({ registry })` and `status({ bundle, registry })` take the
  registry and policy as values; `bundle.fingerprint()` hashes a bundle's
  content. `stripSections` moved to `common.cjs` (sync.cjs re-exports it), the
  Windows junction fallback runs `mklink` as argv rather than a shell string,
  `sensitivePatterns()` is compiled once, and path comparison keeps case on
  Linux. Leg (github.com/ucsandman/legcli) embeds the engine byte for byte.
  Regression: reg-harness section 10.

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-09-06

The repository is now one product: a harness porter. Capture the harness you
already run in one AI coding client and apply it, identically, to every other
client you have installed.

### Added
- `engine/harness/`: the port engine. `capture` reads a client into a
  client-neutral bundle (`harness/`: rules with imports inlined, identity,
  hooks, skills, agents, commands, MCP servers, permissions); `apply` renders it
  into every installed client through a guarded writer with backups, hand-edit
  detection, managed regions inside user-owned files, per-key ownership and
  pruning. `status` and `explain` report per client and per component what is
  in sync and what was dropped, with a reason for every drop.
- Sources: Claude Code and Codex CLI. Targets with their own dialect: Codex CLI
  (`config.toml` hooks with pre-computed trust hashes so no `/hooks` review is
  needed, `agents/*.toml` with the model ladder mapped, `prompts/`,
  `[mcp_servers]`, `rules/*.rules` prefix rules, duplicate-skill disabling),
  Claude Code (reverse direction), Gemini CLI, Antigravity CLI, Cursor; a
  generic adapter (rules, identity, skill links, MCP, commands, agents) for
  Windsurf, Copilot, Cline, Aider, OpenHands, Goose, Continue, Zed, OpenCode,
  Trae, Amazon Q, Cody, OpenClaw, Hermes and the generic system prompt.
- `engine/hooks/shim.cjs`: runs unmodified Claude-dialect hooks under Cursor,
  Gemini CLI and Antigravity by translating the payload in and the decision
  out, chaining several guards into one call so the first deny and its reason
  survive clients that merge hook results.
- `core/port.json`: the port policy (source, targets, exclusions with
  reasons, target-only hooks, model ladders).
- Registry entries for Codex CLI, Gemini CLI, Antigravity CLI and OpenCode; every
  entry now carries its home, hook config, skills, agents, commands and MCP
  surfaces. `docs/targets.md` regenerated with the component matrix.
- `engine/tests/reg-harness.cjs`: capture, apply twice, check, drift, prune,
  reverse port, shim wire tests and the CLI, all in throwaway homes.
- `docs/porting.md`: what each component is, how it maps per client, what is
  deliberately not ported and why, how ownership and secrets are handled.
- `tools/sync/parity`: the status page now shows the per-component matrix,
  dropped items and a "Port now" button.
- `npm run port`, `port:check`, `capture`, `apply`, `status`, `status:open`,
  `explain`, `launch`.

### Changed
- The Python coding agent moved to its own repository,
  https://github.com/ucsandman/agnostic-agent (history preserved). This repo
  has no Python and no `pip install`; CI runs Node 18 and 22 on Ubuntu and
  Node 22 on Windows.
- `engine/setup/first-run.cjs` runs the port instead of the rules-only sync
  when a source client is present, and no longer writes flat
  `{"pre_tool_use": ...}` hook files for Codex and Gemini (a format neither
  client reads, which clobbered a real config on 2026-08-18). Hooks for those
  clients come from the port.
- `launch.py` replaced by `engine/setup/launch.cjs` (`npm run launch`).
- `npm run sync` is now the optional authoring mode (compile `core/rules` into
  the primary client); the everyday command is `npm run port`.
- README, architecture, configuration, contributing and security docs
  rewritten for the single product.
- `fable-delegate-guard` no longer denies anything. It briefs the session once with
  the measured token economics and logs large edits and code-writing shell commands
  for `--report`. Its own log (1,046 events) showed 714 `# FABLE_OK` overrides, 266
  shell denials that included `npm test`, a heredoc commit message and a read-only
  grep, and edit denials retried five to seven times on the same file: a model treats
  a PreToolUse deny like a transient error, and a cap firing at edit 21 of a coherent
  change set leaves a half-edited file. The per-prompt edit budget, the shell
  code-writing denial, the `# FABLE_OK` override and the "hands-on" / "delegate
  again" prompt toggles are gone; `FABLE_DELEGATE_GUARD=off` now only silences the
  briefing and the log. `isMutatingShell` is unchanged and still owned here for the
  Codex twin, with the 2026-09-05 token-boundary fix (`git show --no-patch` is not
  a mutation).

### Removed
- `agent/`, `tests/`, `pyproject.toml`, `requirements.txt`, `MANIFEST.in`,
  `.vulture_whitelist.py`, `launch.py`, and the agent docs (orchestration,
  slash commands, MCP client, memory, subscriptions, usage), all now in
  agnostic-agent.

## [1.5.2] - 2026-09-05

### Fixed
- Let injected subscription client factories validate their own transport instead
  of requiring the built-in local CLI. Normal clients retain CLI availability
  checks, and the metered API restriction remains enforced.

### Changed
- Require new harness mechanisms to justify their ongoing cost through reduced supervision.
- Allow automatic context compaction while preserving the active task and handoff evidence.
- Identify Codex lifecycle events before Claude-compatible payloads and omit unsupported bare approval decisions.
- Correct the runtime badge's target count and distinguish configuration from verified enforcement.

## [1.5.1] - 2026-09-05

### Fixed
- Serialize Claude and Codex pre-tool decisions inside the required
  `hookSpecificOutput` envelope. Denied tools retain exit code 2 and a reason
  on stderr. The hooks stay enabled.
- Add eight real-process protocol checks for both guard runners, including
  allow/deny and shell/MCP inputs, and run them in CI.
- Regenerate the supported-target documentation from the current registry.
- Correct the obsolete 18-target parity assertion and package descriptions to
  match the 16 configured sync targets.
- Preserve existing lifecycle hook configurations during first-run setup.
  Four fixture checks verify empty and populated configurations stay
  byte-identical for Codex and Gemini, with truthful guard-presence reporting.

### Added
- `engine/hooks/capability-graph-guard.cjs`: enforces the Claude Code subagent
  capability graph (Fable -> Opus/Sonnet/Haiku, Opus -> Sonnet/Haiku, Sonnet ->
  Haiku, Haiku -> nobody, downward only) plus the read-only `advisor` upward
  edge, wired by `first-run.cjs` into `PreToolUse`, `SubagentStart` and
  `SubagentStop`; disable with `CAPABILITY_GRAPH_GUARD=off`. The real
  `SubagentStart` payload carries `subagent_config: null`, so the caller model is
  resolved lazily by `callerModelFor` (registry -> `subagent_config` ->
  `<session_dir>/subagents/agent-<id>.meta.json` -> the subagent's own transcript
  -> agent-file frontmatter) and cached back into the registry; without that
  every subagent resolved to `unknown-caller` and was allowed.
- `engine/hooks/fable-delegate-guard.cjs`: delegate-first enforcement for a Fable
  main loop in Claude Code. While the session model is Fable it budgets direct
  edits (free under `~/.claude` and the session scratchpad, 3 small ones per
  prompt elsewhere) and denies code-writing shell commands, injects the
  delegation briefing once per session, and exempts subagents. Wired by
  `first-run.cjs` into `PreToolUse`, `UserPromptSubmit` and `SessionStart`.
  Override one command with `# FABLE_OK: <why>`; disable a session with
  `FABLE_DELEGATE_GUARD=off`; audit with `--report`.

### Changed
- Plain `git push` is no longer a hard stop in `core/safety/guards.json`; force
  pushes, hard resets and the other destructive forms still require approval. A
  hook cannot ask a human, so the plain form blocked every push from Claude
  Code.

### Fixed
- Orchestration hardening after an adversarial review of 1.5.0:
  subscription-CLI children run confined to their workspace with native tools
  disabled (`claude --tools ""`, `codex --sandbox read-only`; `agy` is skipped);
  `read_url_content` fetches http(s) only and lives under a separate `network`
  permission that read-only roles do not get; `delegate_parallel` without
  `workspace_mode` still rejects shared mutation; graph limits reset per turn and
  per `/research`/`/review`/`/swarm` instead of accumulating for the session; a
  stale Esc no longer poisons the next subagent; hard-stop confirmations are
  serialized across parallel children; one rejected sibling no longer discards
  the batch; a mutating child that asked for `branch` fails closed; failed and
  cancelled branch children still hand their diff upward; worktrees live outside
  the repo and `/org prune` sweeps orphans; graph details are redacted and
  paths relative; `max_turns` keeps the child's last output; shorthand model
  overrides keep the inherit fallback; keyless `provider`+`base_url` targets and
  `api_key_env` work; the empty `tests` permission is gone; orchestration events
  render in every shell; a malformed config is a notice, not a failed headless run.
- Subscription only, delegate-first: subagents never use a metered API (defaults are
  the Claude login per role, falling back to the Codex login; `allow_api_models`
  opts in), subscription CLIs are launched without the vendor API-key variables so
  they bill the login, harness model names map to CLI aliases (`claude-haiku-4.5`
  -> `haiku`; the raw id made Claude Code run its default model), and an expensive
  interactive model (Fable) turns orchestration on in delegate-first mode with a
  per-operation cap on expensive-model agents.

## [1.5.0] - 2026-09-02

### Added
- Adaptive hierarchical orchestration: configurable capability roles can delegate
  directly or recursively across providers, run bounded parallel specialists, and
  consult read-only advisors without transferring ownership. Includes per-agent
  model clients and contexts, programmatic graph/fanout/depth/advisor/model-call
  limits, role tool permissions, cooperative cancellation, owned worktree leases,
  visible fallbacks, `/org` controls, headless/web graph telemetry, and `/swarm`
  reuse of the shared primitive. Default role/model documentation is generated from
  the runtime configuration (`docs/orchestration.md`).
- Smart startup default: with `--url`/`--model` untouched the agent no longer assumes a local
  LM Studio endpoint — it starts on the last `/model` choice (persisted in the new home-level
  `~/.agnostic/settings.json`, distinct from the workspace `.agnostic/settings.json`), else the
  best installed subscription CLI (claude → codex → agy), else the first API-key preset whose
  env var is set, and only then falls back to local. Wired into the TUI and headless `-p`;
  the localhost probe now only runs when the session is actually on the local provider.
- Composer: a paste taller than 12 lines collapses to a `[Pasted text #N +X lines]` marker and
  is expanded back into the message on send; typing a bare `/prefix` shows a live menu of
  matching slash commands with their help lines directly under the composer.
- Codex reasoning effort: the openai-sub bridge passes `/model` effort to the CLI as
  `-c model_reasoning_effort=...` — the status line used to claim effort was unsupported there.

### Fixed
- "The command line is too long" on Windows: the subscription bridge passed the whole flattened
  transcript as one argv argument, and `codex.cmd` goes through cmd.exe's 8,191-char limit, so
  any real conversation died on the first turn. The prompt now rides stdin (`codex exec -`,
  piped `claude -p`); `agy --print` keeps argv (no plain-text stdin path) but is an .exe with
  the larger 32K limit.
- Session badge version is now single-sourced: `core/rules/global-rules.md` carries a
  `{{VERSION}}` placeholder that `npm run sync` fills from `package.json`, and sync refreshes
  `storage/harness-installed.json` to the live version. `package.json` bumped 1.3.0 -> 1.4.0
  (it was left behind at the 1.4.0 release, and the badge literal at 1.2.0). A parity test
  asserts the compiled badge, `package.json` and `agent/__init__.py` agree.

## [1.4.0] - 2026-08-20

### Added
- Turn-done notification: a terminal bell plus a toast (`3 files changed · 2m14s`) when a turn
  that ran 5 seconds or longer finishes while the terminal is unfocused, for agent turns and for
  /test, /fix and the other background workers. Safe-off on terminals that never report focus,
  toggled and persisted with `/notify on|off` (new workspace settings file
  `.agnostic/settings.json` via StateManager.get_setting/set_setting).
- /diff: a turn browser over the automatic per-turn checkpoints — bare `/diff` in the TUI
  opens a picker (newest turn first, each row saying how many files it changed) and prints a
  unified diff per file from the write snapshots, `/diff <turn>` skips the picker, and the
  legacy CLI lists the checkpoint names. Read-only, and usable while a turn is running
  (agent/tui_diff.py, UndoManager.changed_since).
- Multi-line composer: the TUI prompt is a TextArea (agent/tui_composer.py) instead of a
  single-line Input — Enter sends, Shift+Enter / Alt+Enter / Ctrl+J insert a newline, the box
  grows to 8 lines then scrolls, and a pasted block keeps every line (Input kept only the
  first one and silently threw away the rest of a stack trace).
- /memory: a picker over the saved memories (bare `/memory` in the TUI, ↑/↓, Space/Enter to
  print one in full), plus `/memory show|save|forget <name>` in both shells — the store was
  writable only by the model until now (agent/tui_memory.py, docs/memory.md).
- Headless mode: `agnostic -p "..."` (aliases `--prompt`, `--print`, `-` reads stdin) now runs
  one turn with no TUI through agent/headless.py — the answer alone on stdout (or one object
  with `--output-format json`), tool/system/error chatter on stderr, exit 1 when the turn
  errored, and hard stops denied unless `--yes` is passed (docs/configuration.md).
- Persistent auto-memory: workspace store in .agnostic/memory/ (MEMORY.md index +
  one markdown file per memory), injected into the system prompt as
  "## Memory (auto-recalled)", with save_memory / recall_memory tools (agent/governance/memory.py).
- MCP client (zero-dependency, stdio JSON-RPC): servers from .agnostic/mcp.json,
  .mcp.json (Claude Code format) or ~/.agnostic/mcp.json register as
  mcp__<server>__<tool> and run through the governed execute() path;
  registry.mcp_status() reports state (agent/tools/mcp.py).
- /mcp: a Server / State / Tools / Error table of the configured MCP servers, /mcp reload
  to restart them and re-read the config files without leaving the session, and a red
  `!mcp` badge in the TUI status bar while any server is in the error state — a
  misconfigured server used to fail silently into the log.
- Subscription bridges rewritten: every fenced tool call parsed (not just one),
  claude -p session continuity via --session-id/--resume with delta sends,
  --output-format json preferred, codex resume when supported, usage surfaced
  for cost tracking (docs/subscriptions.md).
- Usage / cost / latency log: .agnostic/usage.jsonl with p50/p95 and cost
  summaries; agent/llm/pricing.json ships with explicit nulls for the user to
  fill in — costs are never invented (agent/llm/usage.py, docs/usage.md).
- Every LLM call is now journalled: `LLMClient.chat_completion` writes one
  `.agnostic/usage.jsonl` entry per call on every path (API, streaming,
  subscription bridge; success and failure), streamed turns keep the usage chunk
  that arrives with an empty `choices` list, and the numbers surface as a dim
  `$ 0.42 - p50 12.3s` segment in the TUI status bar and a `p50 12.3s | $0.42
  today` column in the `/model` picker.
- A bare `/session` in the TUI opens an arrow-key resume picker of this
  workspace's saved sessions (newest first, with turn count, timestamp and
  notes) and loads the chosen one; `/session save|load|list <name>` is
  unchanged, so the flat list stays greppable.
- Double-Esc rewind in the TUI: every turn is checkpointed silently, and pressing
  Esc twice while idle opens a two-step picker — which turn, then whether to
  restore the files, the conversation, or both. The generic half of the `/model`
  picker moved to `agent/tui_picker.py::PickerScreen`, which the rewind screen
  subclasses.
- TUI tool cards now carry the tool name, how long it ran and how many lines the
  fold hid (`⚙️ run_command · 3.4s · +812 lines hidden — ctrl+o`), clipped on a
  line boundary instead of mid-line, and `Ctrl+O` prints the last tool's output
  in full — the escape hatch ships with the fold.
- A `!` prefix in the TUI runs a shell command locally without spending a turn:
  `!git status`, `!ls tests`. It goes through the same `run_command` tool the
  model uses, so `core/safety/guards.json` stays the single policy source and a
  hard-stop command still asks, and it appends nothing to the conversation —
  zero context, zero LLM calls.
- The TUI status bar carries a `CTX ███░░░░░░░  31% (620k/2.0M)` gauge — bar,
  exact percentage and colour (green/yellow/red), fixed width so it never
  shifts — and warns once, before the cliff, naming the auto-compaction
  threshold and the remediation. `/compact` now prints what the distillation
  kept, and `/compact undo` restores the pre-compaction messages.
- Typing ahead during a governance hard-stop no longer revokes it: text that is
  not a y/n answer is queued as a prompt and the confirm stays pending (Esc is
  the explicit deny, so a worker can never block forever). A verdict can carry a
  reason — `n: too risky, patch the test instead` denies and prepends the reason
  to the next turn.
- Shift+Tab in the TUI cycles the trust tier (`strict` → `trust-reads` →
  `trust-tests` → `trust-all` → `strict`), and the status bar carries a `🛡`
  badge read live from `SafetyGuard` on every repaint — red on `trust-all` — so
  the displayed tier can never drift from the one being enforced.
- Ctrl+C in the TUI escalates instead of scolding: while a turn runs it cancels
  it, and a second press within 1.5s force-exits (idle, two presses quit). Ctrl+L
  asks twice before clearing the log. Both share one `_double_tap` timer.
- Live busy indicator in the TUI status bar: `∴ Percolating… 47s · esc to cancel`,
  ticking once a second while a turn or background worker runs, with the verb
  chosen once per turn (override the pool with `AGNOSTIC_SPINNER_VERBS`). The
  status bar is now built as a `rich.text.Text`, so a cwd or model name
  containing `[` can no longer be parsed as markup.
- `/model` in the TUI is an interactive picker (`agent/tui_model_picker.py`):
  arrow keys move, Space/Enter select, Esc steps back. Preset → (subscription
  presets only) concrete model → effort, the last step skipped when the model
  ignores it.
- Subscription presets can pin the model their CLI runs: pick Claude Code
  Monthly Subscription, then `claude-fable-5`, and the bridge passes
  `--model claude-fable-5` to `claude` (`-m` for `codex`, `--model` for `agy`).
  `LLMConfig.sub_model`, `LLMConfig.sub_models(key)`,
  `switch_model(sub_model=...)`; text form `/model 2 claude-fable-5 high` (any
  order after the key, legacy CLI included). Status bar shows `preset › model`.

### Changed
- `agent/tui.py` (1352 lines) split: the slash-command dispatcher and `/commit`
  workflow moved verbatim into `agent/tui_commands.py` as `SlashCommandMixin`
  (~450 lines). No behaviour change; `AgnosticTUI` inherits the mixin. The
  background-dispatch test now parses the method's own source file.

## [1.3.0] - 2026-08-20

### Security
- Command center (`tools/dashboard`) and parity UI (`tools/sync`): every
  mutating `POST` route now requires a per-process token plus a loopback
  `Origin`/`Referer`; request bodies are capped at 1 MB. Previously any page
  open in the browser could trigger a sync, approve a rule into the SSOT, or
  rewrite governance config.
- Dashboard guard simulator now evaluates `core/safety/guards.json` through the
  real local guard instead of a separate hardcoded pattern list.
- Removed three fabricated "audit events" (including a "zero secret leaks"
  scan result that never ran) from the governance view; it now shows only real
  events and an explicit count.
- `tools/errorlog --selftest` now asserts and exits non-zero on failure.

### Performance
- `agnostic --help` and test start-up: the `openai` SDK is imported lazily.
- `grep_search` / `find_files` skip `node_modules`, `venv`, `dist`, `build` and
  similar directories (same list the indexer uses) and run the cheap path
  filter before the safety-guard check.
- `@file` / `#symbol` lookups reuse one `SafetyGuard` per workspace instead of
  re-reading and re-compiling `guards.json` on every reference.
- Web companion shuts down promptly (`poll_interval=0.05`), which also cuts
  ~6 s from the Python test suite.
- `/api/projects` loads the skills manifest, config and candidates once per
  request instead of once per project.
- `grep_search` / `find_files` prune ignored directories during the walk
  (`os.walk` + `dirs[:]`), skip binary extensions, prefilter each file in one
  pass and run the path guard only on real matches — ~6× faster on this repo.
- AST indexer keeps a per-file symbol map, so re-indexing a changed file no
  longer scans every symbol in the workspace (was 41 % of a full index).
- TUI start-up no longer blocks on the workspace index or the endpoint probe;
  both run as background workers and the banner updates when they answer.
- `@file` / `#symbol` expansion runs on the turn worker, not the UI thread.
- The interceptor no longer spawns a `node` process after every tool call
  (the correction tracker could never fire from that payload).
- `SessionManager.list_sessions()` caches per file by mtime; the web companion
  polls it at 1 Hz.
- One `httpx.Client` per timeout value is shared by every `OpenAI` client and
  the `ModelDoctor` probe instead of building a new SSL context (~200 ms) on
  every construction and `/model` switch; the old pool no longer leaks.
- Command center reads `dashboard.html` once at start-up instead of 142 KB per
  request; the error search is debounced and says when it hits the 500-record
  cap.

### Added
- `agnostic --version`.
- **Esc cancels a running turn.** `AgentLoop.cancel_event` is checked between
  steps and before every tool dispatch; `run_command` kills its child; pending
  tool calls are answered `[cancelled by user]` so the history stays valid.
- `run_command` output streams live into the TUI's growing block (and the
  legacy CLI) while the command runs; the final result card is unchanged.
- `/schedule list` and `/schedule stop <id>|all` for background routines.
- `find_symbol` tool: the AST symbol index the `#symbol` prompt syntax already
  used is now available to the model (read-only, runs in the parallel batch).
- `engine/sync/sync.cjs` `run({check, force, target})` takes options; the
  dashboard and parity UI no longer depend on `process.argv`.
- The Node harvester also reads the cross-client `storage/corrections.jsonl`
  the correction-tracker hook writes.
- Lint feedback: after a successful `write_file` / `edit_file` / `apply_patch`
  of a `.py` file, `ruff check` output is appended as an advisory `[lint]` note.
- The agent system prompt now appends the workspace's own `AGENTS.md` /
  `CLAUDE.md` / `GEMINI.md` / `CONVENTIONS.md` (and `.agnostic/state.md`),
  clipped to ~6 KB.
- TUI: `@file` / `#symbol` Tab completion (prefix before substring, cycles on
  repeated Tab), ↑/↓ prompt history shared with the legacy CLI's history file,
  `/model` with no argument prints the preset table with live availability and
  supports `/model <n>`, `/help` is rendered from one command table shared by
  both UIs (a test keeps it in sync with `docs/slash-commands.md`).
- CI: `windows-latest` leg (Python 3.12) so the junction / CRLF / `.exe` paths
  are exercised.
- Tests: import smoke test over every `agent` submodule (14 modules were never
  imported by any test), end-to-end `/undo` test, distill legacy-record test,
  merge preamble / nested-bullet test, first-run backup test, traits-drift
  test, cancel / lint / line-ending / regex-grep / streaming / scheduler tests;
  the preset test is parametrized over all presets with the client stubbed.
  138 → 245 pytest, 23 → 28 engine tests, 11 → 13 sync regressions.
- `pyproject.toml` (PEP 621) with a `dev` extra (`pytest`, `ruff`) and ruff /
  pytest configuration; `setup.py` removed.
- `docs/` (architecture, configuration, slash-command reference, generated
  client table), `SECURITY.md`, `CONTRIBUTING.md`, issue and PR templates.
- `npm run docs:targets` / `docs:check`: `docs/targets.md` is generated from
  `core/templates/targets.json` and checked in CI.
- CI: ruff, Python 3.9 + 3.12 matrix, generated-docs check.

### Fixed
- Port collisions no longer hand you another app's UI. The command center used
  to treat any `EADDRINUSE` on 7842 as "already running" and open a browser at
  whatever was listening; it now probes for its own `x-agnostic-dashboard`
  header and, if a foreign app owns the port, binds the next free one (10 tries)
  and prints the URL it actually bound. `--port N` works as documented.
- The web companion (`--web`, `/web`) walks up from 7843 to the next free port
  instead of refusing to start when the port is taken, and reports the port it
  actually bound when started twice.
- **Compact prompt mode (the default) now carries your rules.** It used to
  replace the compiled `global-rules.md` with a hardcoded five-line prompt; it
  now clips the real rules to ~4 KB. A missing compiled prompt is reported
  (`npm run sync`) instead of silently falling back to a stub.
- **Line endings are preserved.** `write_file` / `edit_file` / `apply_patch`
  and `/undo` restores wrote with platform newlines, so on Windows one edit
  rewrote an LF file as CRLF; edits that target `\n` still match CRLF files.
- Read-only tool output is truncated to head/tail beyond 120 lines as the docs
  always claimed (`read_file` with an explicit line range is exempt);
  `grep_search` / `find_files` say when they hit their 40 / 50 result caps.
- `grep_search` does what its description says: regex (case-insensitive), with
  a literal fallback that names the mode it ran in.
- A turn that aborts between an assistant tool call and its result (exception,
  Ctrl+C) no longer bricks the session: trailing tool calls get an `[aborted]`
  result so the next request is well-formed.
- TUI: the banner no longer shows a green check for an offline endpoint; a
  pending y/n approval is visible in the prompt and a non-y/n answer is echoed
  back instead of silently swallowed; background commands (`/test`, `/review`,
  `/swarm`, `/distill`) stream their output live instead of dumping it at the
  end; the reply streams into one growing block instead of relabelled
  fragments; the Tab binding actually fires (Textual's screen binding shadowed
  it).
- Subagent `share` workspace mode handed the worker an empty directory; it is
  removed and `branch` falls back to the real workspace when no worktree can be
  created.
- `candidates.jsonl` and session files are written atomically (tmp +
  `os.replace`).
- `engine/tests/reg-hooks.cjs` crashed the whole suite when port 3000 was taken
  (listen error is an event, not a rejection); it binds an ephemeral port.
- `distill` crashed on legacy candidates without `sightingDays` and on
  corrections without `correction`; records are normalised once at load.
- `merge.cjs` dropped every rule above the first `##` heading and flattened
  nested bullets, then overwrote `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` with
  no backup; preamble and indentation are preserved and targets are backed up.
- First-run setup no longer overwrites its own pristine settings backup on the
  second run.
- `sync --check` and the parity UI report a target stale when only the traits
  file drifted.
- Scheduler task ids no longer collide within the same second; swarm worktree
  paths are unique, git calls time out, synthesis survives a `None` worker;
  the subscription CLI bridge kills a hung child on timeout instead of leaking
  it.
- Web companion shows the actual test / distill output (not just the exit
  code) and disables the button while a run is in flight; every command-center
  routine button shows a pending state and cannot double-fire.

### Removed
- Tools the model could never use successfully: `ask_question` (no input
  channel), `generate_artifact` (a `write_file` with a worse path),
  `manage_subagents` (`kill` was not implemented). Three fewer schemas on every
  request.
- Dead modules: `agent/workflows/planner.py`, `TaskManager` / `BackgroundTask`
  in `diff_viewer.py` (faked a cron schedule), `agent/tools/mcp_client.py`
  (stub), `agent/tools/mcp_discovery.py` (no caller), and the Python
  `agent/governance/harvester.py` — `/harvest` now shells out to the same Node
  harvester `npm run harvest` uses, so there is one harvester and one
  behaviour.
- `requirements.txt` is a one-line `-e .` shim; `pyproject.toml` is the single
  source of dependencies.
- `tools/errorlog` (a two-line alias of the command center; `/api/data` serves
  the same payload), `/grill-me` and `agent/workflows/grill.py`, and every
  `# noqa: vulture` marker in the code (ruff warned on each one). The vulture
  whitelist moved to `.vulture_whitelist.py`, which the pre-commit hook picks
  up; it lists only framework callbacks and cross-UI entry points.

### Changed
- README rewritten to describe what the code actually does (swarm roles,
  worktrees off by default, all four local ports, every slash command and
  npm script, Windows-first note).
- `/multiline` in the Textual TUI now answers (pointing at `agnostic-legacy`)
  instead of being sent to the model. A test now asserts every entry in
  `SLASH_COMMANDS` has a dispatch branch.
- URL-fetch tool identifies itself as `AgnosticAI/<version>` instead of a
  browser user agent.
- `except Exception: pass` sites narrowed or surfaced; sandbox rollback now
  reports whether `git restore` / `git clean` actually succeeded.
- Generated runtime state (`storage/skills-manifest.json`,
  `storage/prune-report.json`, `storage/deleted-candidates.json`) is no longer
  tracked.

## [1.2.0] - 2026-08-20

### Added
- Textual-based TUI (`agnostic`) with an always-available input box; the
  prompt_toolkit shell remains as `agnostic-legacy`.
- Promotion loop closed: approving a candidate from the dashboard writes the
  rule into `core/rules/global-rules.md`.
- Native subscription bridges (`agy`, `claude`, `codex` CLIs) and hosted API
  presets behind `/model`.
- Parallel read-only tool calls, mtime-based AST cache, output truncation,
  multi-file checkpoints, session bookmarks, `/swarm`, `/diagram`, `/test`,
  `/fix`, `/pr`, `/learn`, `/grill-me`.
- CI workflow running pytest and the three Node suites.

### Fixed
- Claude Code `PreToolUse` hook schema written by first-run setup.
- Duplicate system messages on auto-compaction; web companion live telemetry.

## [1.0.0] - 2026-08-18

### Added
- Initial harness: rules SSOT, 18-target sync engine, cross-agent merge,
  harvester, 4-tier distillation ladder, DashClaw governance hooks, skill
  consolidation and recommendation, local command center.
