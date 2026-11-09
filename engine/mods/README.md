# ~/.claude/mods — the harness's Function Hooks (Mods) layer

Two installed plugins from the local marketplace in this directory, one mode config, one state dir.
Promoted from the claude-mods research record (now `labs/claude-mods`) on 2026-09-16 against Claude Code 2.1.273.

```
mods/
  .claude-plugin/marketplace.json   local marketplace "harness-mods" (extraKnownMarketplaces in settings.json)
  harness-runtime/                   the shared runtime adapter: the ONE reader of Anthropic's raw
                                    function-hook events → runtime.emit bus + $.runtime.{emit,supports,judge,snapshot}
                                    + state/events/<session>.jsonl (consumed by LegCli, handoff bundle, Discovery Loop)
  harness-mods/                     the harness Mod: routing, context nudge, secret redaction, measured
                                    subagent accounting, read cache — each in classic | shadow_mod | mod
    hooks/index.tsx                   glue only
    hooks/lib/*.mjs                   pure policy (node --test tests/)
    tests/lib.test.mjs                10 tests; tests/gen-patterns.cjs regenerates the secret-pattern copy
  mods-config.json                  the per-guard mode (the single source both sides read)
  canary.cjs                        the Mods leg of guard-canary.ps1 (node mods/canary.cjs [--quick|--json])
  shadow-report.cjs                 pairs classic vs Mod comparison rows (node mods/shadow-report.cjs)
  state/                            runtime output, never tracked: sessions/<id>.json (heartbeat + status),
                                    events/, shadow/, subagents.jsonl, redactions.jsonl, liveness.jsonl,
                                    canary-status.json, canary-leg.json
```

## What has to be on for any of this to load

Function hooks are behind an experimental switch. Without it Claude Code never calls `register()`, so
there is no `/mods` command, no heartbeat, and the statusline shows `MOD none` while `claude plugin list`
still cheerfully lists both plugins as enabled — the failure is silent and looks like a plugin problem.

```
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1     in settings.json → env  (user scope, so every session gets it)
```

It lived only in the promoting session's terminal until 2026-09-16, which made the whole layer invisible in
every normally started session. Check with `/mods` (or `ls mods/state/sessions` for a fresh heartbeat), not
with `claude plugin list`.

## What each guard does in `mod` mode (and what stood down)

| Guard | Mod behaviour | Classic hook that stands down | Kept classic |
|---|---|---|---|
| `routing` | `agent.spawn`: rewrites the model onto the capability graph (Fable→Opus/Sonnet/Haiku, downward only, advisor one rung up, Fable cap 3), prices the spawn against a learned prior with the `# EST:` break-even rule + anti-thrash, denies only a Haiku parent or an undeclared scope on its first attempt, and explains every rewrite to the parent on the Agent tool result | `agent-model-guard` (Agent/Task branch), `capability-graph-guard` (PreToolUse), `subagent-budget-guard` (pre-spawn) | the Workflow script lint in `agent-model-guard`; `subagent-budget-guard --post`; SubagentStart/Stop registry |

The Mod draws no band of its own (removed 2026-09-18: the AbovePrompt tree and `$.ui.status` were the
same line the statusline already shows from the heartbeat, three times). `/mods` prints the band; the
statusline badge is `MOD OK M x5` when all five guards are armed in mod mode, or names the exceptions.
| `secretRedaction` | `tool.call`: every tool result (all tools, MCP included) is scanned with the shared vendor-prefixed shapes and each match replaced by `<REDACTED:kind:len>` BEFORE the model sees it; the transcript records the redacted result; `state/redactions.jsonl` + a toast | `tool-output-secret-watch.cjs` (after-the-fact alert) | `secret-guard.cjs` (inputs), `output-secret-watch.cjs` (message text), the pre-commit chain |
| `subagentAccounting` | per-agent usage from the bus; reserved (prior) vs measured; prediction error vs `# EST:`; two learned medians per type in `$.store` (OVERHEAD = tokens before the first tool call, what the break-even rule prices; TOTAL = the whole run, what the ledger reserves; a stored total never prices overhead, 2026-09-18); rows to `state/subagents.jsonl` and to `hooks/.subagent-budget-log.jsonl` (`decision:"measured"`, ignored by calibrate.cjs) | nothing (observation) | `calibrate.cjs` and its historical log |
| `readCache` | the 3rd exact identical observation of an unchanged file (Read with no offset/limit, plain `cat`) is served from cache with a context note; observations across Read/Grep/Glob/cat/head/tail/wc are counted per FILE; Write/Edit/shell writes invalidate | nothing | — |

## Commands

```
/mods | /mods shadow | /mods ledger | /mods rollback        in a session
node ~/.claude/mods/canary.cjs                               full health (also run by guard-canary.ps1)
node ~/.claude/mods/shadow-report.cjs [--session <id>]       classic vs Mod comparison
node --test ~/.claude/mods/harness-mods/tests/               pure policy tests
node ~/.claude/hooks/tests/mods-mode-probe.cjs               the classic stand-down rule
claude plugin validate ~/.claude/mods/harness-mods --json    the loader's static scan
```

## Deploying an edit

An edit under `engine/mods` is live at the next session start (or `/reload-plugins`); no reinstall. Claude Code reads a folder-marketplace plugin from its folder, and `~/.claude/mods` is that folder. The copies under `~/.claude/plugins/cache/harness-mods/<plugin>/<version>/` are dead install-time snapshots: `installPath` in `installed_plugins.json` points at them, `claude plugin update` says "read from its folder, nothing to update", and a `diff -rq` against them measures nothing. Proven 2026-11-08 on 2.1.319: a marker planted only in the cache copy of `canary.mjs` never reached the next session's heartbeat. A manifest change (`plugin.json` name or version) is the one edit that needs `claude plugin marketplace update harness-mods` and an uninstall/reinstall, adapter first so it stays outermost.

## Rollback (classic hooks are still installed; they take over the moment the Mod stops arming a guard)

- one guard, every session: set it to `"classic"` in `mods-config.json`
- one session: `HARNESS_MOD_ROUTING=classic` (`_SECRET_REDACTION`, `_SUBAGENT_ACCOUNTING`, `_READ_CACHE`) or `HARNESS_MODS=off`
- the layer: `claude plugin disable harness-mods@harness-mods` (`harness-runtime@harness-mods` may stay; it only observes)
- a Claude update: a **minor/major** change (2.1.x to 2.2.x) fails `version` until you re-run `labs/claude-mods/lab/probe*` and repin, because event shapes can move. A **patch** change (2.1.273 to 2.1.274) is a warning, not a failure, provided the in-session capability probe is clean on the installed build: all 9 of `EXPECTED_SUPPORTS` answering true is direct evidence the API the Mod depends on is intact, where the version string is only a proxy for it. Clear a stale pin with `node ~/.claude/mods/canary.cjs --repin`, which refuses unless both the canary and the probe are clean and updates `canary.cjs` and `canary.mjs` together. Changed 2026-09-17: the old exact-match pin went red on every patch release, and a canary that cries wolf gets ignored.

## Invariants (checked by tests)

- A decision is owned by exactly one side per session: classic yields only under `mod` + a fresh heartbeat that armed the guard.
- `hooks/lib/secret-patterns.cjs` is the single source of secret shapes; `harness-mods/hooks/lib/secret-patterns.mjs` is a generated copy and the test fails on drift.
- The Mod never logs a secret value (hits carry kind, 8-char head, length).
- Only `harness-runtime` reads raw engine events for observation; `harness-mods` hooks raw events only where it must intercept.
