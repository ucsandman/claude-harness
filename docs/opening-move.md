---
name: opening-move
description: "The SessionStart brief, the NEXT ladder and the go binding, the Stop-time Next ledger, the nightly digest with its T0 repairs and job contracts"
context:
  triggers:
    keywords: ["opening move", "opening-move", "Next (me)", "go binding", "turn-close", "digest.json", "verifyGate", "LEFT FOR WES", "harness red", "job contract", "stale artifact"]
    paths: ["~/.claude/state/opening-move/**", "~/.claude/jobs/**"]
  priority: 60
---
# Opening Move

Every session opens with what changed, what is red and one NEXT with an owner;
"go" starts it. Every session closes by writing its Next line into a ledger the
next session reads. A nightly digest measures the harness, repairs three
allowlisted faults and proves its own instruments against a fixture. Standing
orders live in `CLAUDE.md` (How to Work, "Opening move"; ADHD rule 3).

## The brief (`engine/hooks/opening-move.cjs`, SessionStart, cli only)

One `systemMessage` line plus an `additionalContext` block, built in under 200 ms
from git, the repo's ring of recent sessions, the markers and `digest.json`:

- `[opening-move] <repo> @ <branch> <sha>. Built in <ms>: <what was measured, with counts>; digest <age> (<n> of 8 sources, fixture <n> of 5).`
- `SINCE <last session>:` commits by author, pushed or not, files the last session touched.
- `RED:` digest red items, short forms cut at a word boundary.
- `LEFT OPEN:` ranked items below NEXT. `LEFT FOR WES:` owner `you`, never started.
- `NEXT (<owner>) [<kind>, rung <n>, <age>]: <text>. About <est>.`
- `also (demoted):` muted kinds; `INBOX:` agent-comms files naming this repo;
  `LIVE SIBLING:` another session prompted here recently.
- `rules: <n> of 10 matched, <skipped> (source absent: …)`, then `clean (fixture 5 of 5)`
  or `clean (UNVERIFIED: …)` when the fixture did not prove the instruments.
- `USE:` the contract the model follows (Wes's prompt wins; go starts a `me` NEXT).

Owners: `me` (started on "go"), `you` (a hard stop, a click, a sign-in; prepared,
never executed), `wait <date>` (hidden until then), `none`. The hard-stop filter
(`HARD_STOP_RE`: deploy, publish, release, migrate, force push, send, post, email,
delete, drop, rm -rf, DNS, billing, Stripe, Clerk, Render, Neon, invite) rewrites
a NEXT to `prepare <x>; <x> stays yours`. A hit inside a file name is exempt only
when that file is being edited or read, never bare or after `run`, `node`, `bash`,
`sh` or `./`: the exemption fails closed.

**The ladder.** `rank(state)` is pure; first match wins; text comes from fixed
templates filled with numbers, shas and repo-controlled names only.

| Rung | Kind | Condition | Owner |
|---|---|---|---|
| 1 | ci-red | digest ci row for this repo and branch is `failure`, fetched under 60 min ago | me |
| 2 | tests-red | the last test here failed and none passed since | me |
| 3 | resume | a stored Next under 72 h old, owner me | me |
| 4 | handoff | a handoff slug is indexed for this repo | me |
| 5 | syntax-left | a file was left with a syntax error | me |
| 6 | commit-scoped | files the last session touched are still dirty | me |
| 7 | unpushed-clean | clean tree, ahead of the remote | me; `you` if the repo deploys on push |
| 8 | harness-red | a digest red item: every item in agnostic-ai or `~/.claude`, elsewhere only a guard-class item, on the RED line only | me |
| 9 | stale-dirty | the oldest dirty file is over 7 days old | me (draft only) |
| 10 | open-task | the first unchecked task item | me |

Stale-top: the same NEXT at the first session of three consecutive days with no
`taken` drops below the next rung for 7 days. Muted kinds become the `also` line.

**The go binding.** The same file runs inside `prompt-dispatch.cjs` on
UserPromptSubmit: it writes the repo's ring row and, on "go", "continue", "next",
"resume" or a greeting, binds the brief's NEXT to that prompt and ledgers `go`.
A `you` NEXT is never bound.

## Turn close (`engine/hooks/turn-close.cjs`, Stop)

Parses the reply's last `Next (<owner>): …` line into the repo's `next` and
records whether the turn edited code and whether a check passed afterwards.
Modes `off | shadow | enforce`: `TURN_CLOSE_MODE` beats `verifyGate` in
`config.json`; shadow (the default) logs a row to `turn-close.jsonl`, enforce
blocks once per human prompt (keyed on the prompt's bus seq). A check started
with `run_in_background`, or whose exit code is masked by `|`, `;` or a lone `&`,
never counts. Refused blocks auto-demote enforce to shadow. Edits by a subagent,
outside a git repo, or while a background task runs are skipped.

## The digest (`jobs/opening-move-digest.cjs`)

The `OpeningMoveDigest` task runs it at 06:50; a brief whose digest is over 60
min old spawns one detached refresh behind `digest.lock` (`{pid, ts}`: stale
when the pid is dead or after 30 min, an empty lock after 10 min; unlinked only
by its owner). Eight sources, each recorded with `ok` and `count`: doctor, guard
canary, job contracts, repos (gitradar), ci (`gh run list`, session runs only,
rows stamped `fetchedAt`), hook errors, learning, fixture. Red items are
templated (`<job>: <file> <n> d old (limit <h> h), last result <code>.`,
`GUARD <leg> is not denying`, Mods legs by name) and hashed on their stable part,
so mutes and stale-top hold across days.

**T0 repairs**, allowlisted in `REPAIRS`: `rules-drift` (sync, then port),
`links` (sync), `install-differs` (`node jobs/install.cjs --apply`). Each is
verified afterwards and ledgered as `auto-fixed` or `auto-fix-failed`. No repair
runs when any session showed life in the last 10 min, when the refresh was
spawned from agnostic-ai or `~/.claude`, when the home has no
`.claude/settings.json`, or under `OPENING_MOVE_REPAIR=off`; `--force`, `--lock`
and `--repin` are banned arguments.

**The fixture** plants five faults (stale-dirty, ci-red, a stale job, a guard
leg, a frozen-file change) under a temp root and asserts the instruments find all
five. A failed sweep is recorded as `found 0 of 5, missed: not run`, never
carried over, and the brief's clean line reads UNVERIFIED (L1, L2).

## Job contracts (`jobs/install.cjs`)

Every job that leaves an artifact declares `expects: {path, maxAgeH}`; a job
whose non-zero exit is its own verdict adds `resultNote` (`CronwatchDaily` exit 1
means the board lists failed tasks). `npm run doctor` (`jobs`) fails on
`STALE <job>: <file> <n> d old (limit <h> h)` or `MISSING-ARTIFACT` and prints
`<n> jobs with contracts, <m> fresh`. First real positive: `NightlyMeditation`,
dark 51 days under a path-only check ([ERRORS.md](ERRORS.md), 2026-11-08).

## guard-canary.ps1 red throttle

While the canary is red, the stored banner replays for 60 min and the probe is
skipped, unless `tools/gates/gate-manifest.lock.json`, `~/.claude/settings.json`
or `~/.claude/mods/state/canary-leg.json` changed after `ranAt`. Frozen-drift
lines and hook-target misses are kept apart, so drift never reads as a missing
hook. The MODS line prints only when the session's cwd is this repository or
`~/.claude`.

## State and switches

`~/.claude/state/opening-move/`: `repos/<key>.json` (ring of 5, `next`,
`lastTest`, `lastBrief`), `sessions/<sid>.json` (7 days), `ledger.jsonl` (90
days), `seen.json`, `mutes.json` (`{all, repos, items, kinds}`), `config.json`
(`verifyGate`), `turn-close.jsonl`, `digest.json`, `digest.lock`.

Digest test switches: `OPENING_MOVE_ROOT` (a stub repo), `OPENING_MOVE_ONLY` (one
source), `OPENING_MOVE_FIXTURE_DROP` (drop one fault); `OPENING_MOVE_FROM` and
`OPENING_MOVE_SPAWNER` are set by the brief. Probes:
`engine/hooks/tests/opening-move-probe.cjs` (`--stub`, `--leaky`),
`turn-close-probe.cjs`, `opening-move-digest-probe.cjs` (`--stub`), plus the
contract tests in `engine/tests/reg-hooks.cjs`.
