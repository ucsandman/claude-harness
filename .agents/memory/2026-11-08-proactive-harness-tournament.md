# Opening Move: final spec (tournament result, grafts folded in)

> **Step 0 result (2026-11-08, Claude Code 2.1.319, observed by Wes):** the hand-built brief was wired through a throwaway SessionStart hook in `.claude/settings.local.json` and shown in a fresh session. `systemMessage` renders as a line under the banner ("SessionStart:startup says: Opening move, agnostic-ai: 1 red, 1 fixed for you …"). `sessionTitle` has no effect: the tab title stayed "Claude Code". Drop `sessionTitle` from §2.2 and from the output contract; the one-line `systemMessage` carries the headline and `additionalContext` carries the body. **Step 2 input (2026-11-09, captured by a throwaway Stop hook in `.claude/settings.local.json`, which took effect without a restart):** the Stop payload on 2.1.319 carries `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `effort{level}`, `hook_event_name:"Stop"`, `stop_hook_active`, `last_assistant_message` (string, the full final reply), `background_tasks[]` (id, type, status, description) and `session_crons[]`. So §2.4 step 2 reads `last_assistant_message` directly and the transcript tail is only a fallback; `prompt_id` is the per-prompt key for "at most once per human prompt". Two red items the sample named were real: the nightly meditation blackout (fixed the same night in discovery-loop `d18c18f`) and the reserved plugin name `claude-runtime` (the brief's NEXT).

> **Step 2 result (2026-11-09):** `turn-close.cjs` is wired on Stop (shadow by default, `config.json` `verifyGate`, env `TURN_CLOSE_MODE`), the dead gate is deleted, and it ran live in another session the same hour (8518 bus events scanned, exit clean). Decisions that narrow this spec: (a) hook timeouts are **10 s**, not 5 (the doctor's floor for command hooks; the 4.5 s internal guard stays); (b) "once per prompt" keys on the **human prompt's bus seq** with `prompt_id` as fallback, because a Stop fired by a task-notification carries the prompt_id of an earlier human prompt; (c) a verify command started with `run_in_background`, or whose exit code is masked by `|`, `;` or a lone `&`, never counts as a passing check; (d) the hard-stop filter's file-name exemption **fails closed**: a hit inside a path-shaped token is exempt only when the token is being edited or read, never when bare or after `run`, `node`, `bash`, `sh`, `./`; (e) the tainted flag is written to the cwd repo's ring row as well as the touched repos. Probe counts: opening-move 14 cases, 30 negatives; turn-close 19 cases; reg-hooks 79. The `jobs/opening-move-digest.cjs` of step 3 is the next writer of `digest.json`; until then the brief prints "digest: not built (step 3)".

> **Step 3 result (2026-11-09):** `jobs/opening-move-digest.cjs` writes `digest.json` (8 sources, T0 repairs behind an allowlist, the 5-fault fixture); `OpeningMoveDigest` 06:50 and `DailyDistill` 07:00 are registered; doctor `jobs` checks the 2.5 contracts (first real positive: NightlyMeditation 51 d); `guard-canary.ps1` replays a red status for 60 min unless an input changed; the brief consumes `digest.json` with a detached refresh behind `digest.lock` once it is over 60 min old. Decisions that narrow this spec: (a) a refresh spawned from agnostic-ai or `~/.claude` never runs repairs, and no repair runs while any session showed life in the last 10 min (ring ts, stopTs, transcript mtime, lastBrief); (b) a lock is stale when its pid is dead or it is 30 min old, an empty lock after 10 min, and only its owner unlinks it; (c) a failed fixture sweep is never carried over (`found 0 of 5, missed: not run`), so the clean line reads UNVERIFIED; (d) ci rows carry `fetchedAt`, the brief ignores rows over 60 min old, and a skipped ci counts as a missing source ("7 of 8 sources, ci skipped"); (e) a fresh artifact with a non-zero last result is red, worded by the contract's `resultNote` when the exit is the job's own verdict (CronwatchDaily exit 1 = board lists failed tasks); (f) mods-leg red text is derived per leg and hashed on the leg name only; (g) every red item is a rung-8 entry in a harness repo, guard-class items only on the RED line elsewhere; (h) the guards.md canary entry moves to `docs/opening-move.md` in step 4 (guards.md sits at 1048/1050). Probe counts: digest 14 cases; opening-move 19 cases, 36 negatives; reg-hooks 81.

## 1. Ranking

Four judges scored the candidates; the maximum total is 240. All four judges ranked Opening Move first.

| # | Candidate | 1st-place votes | Total | Verdict |
|---|---|---|---|---|
| 1 | Opening Move | 4 | 203 | A zero-token brief with one NEXT, and "go" approves it. It is the cheapest and safest candidate. It only advised until the Medic and Loose Ends grafts were added. |
| 2 | Medic | 0 | 197 | Best design for cutting noise and repairing the harness: dead-man artifacts and fixes that count only when the check turns green. Covers the harness only. Grafted. |
| 3 | Loose Ends | 0 | 191 | An evidence-order Stop check that replaces a gate that is dead today. Low base rate. Grafted. |
| 4 | Threadkeeper | 0 | 187 | The owner-tagged `Next` protocol is grafted. It holds work more than it does work. |
| 5 | Say Go | 0 | 185 | Binding "go" to quoted text with time limits is grafted. Its footer ritual and its regex discuss lock are not. |
| 6 | Standing Orders | 0 | 182 | Clever request mining, but its data has dried up (9 prompts in November) and it auto-pushes. |
| 7 | Today Radar | 0 | 178 | The evidence-hash and reason-chip ideas are grafted. Its phone path depends on the dead FleetBriefing job. |
| 8 | Earned Rungs | 0 | 175 | A sound autonomy meta-layer, but nothing changes in week one. The taint cap is grafted. |
| 9 | The Tray | 0 | 170 | One more pull board plus an always-on process on a machine with little free RAM. |
| 10 | Night Shift | 0 | 165 | The fixture canary repo is grafted. 0.8M to 2.7M tokens a night and ten chores is too much. |
| 11 | Wake-on-Red | 0 | 156 | Its `claude --bg` path fails on this machine (ENOENT). 0.3M to 0.45M tokens per triage. |
| 12 | Last Word | 0 | 137 | Off-brief. It opens a public posting path and widens the hard-stop rule. |

## 2. The winning concept: Opening Move

### 2.0 Every judge objection, resolved

| Objection | Resolution in this spec |
|---|---|
| The demo NEXT `canary.cjs --repin` is wrong | Confirmed. `canary.cjs:123` exits 1 with "repin refused: canary is not clean". `mods/state/canary-leg.json` shows only `validate-claude-runtime:false` (note `[]`), and `version` is true. The brief reads per-leg `results{}`, never the notes. The NEXT names the failing leg (§2.5, §2.6). |
| Advisory only | Three fixes. (a) The digest runs T0 deterministic repairs and reports "fixed for you". (b) "go" starts a `me` NEXT. (c) A commit NEXT comes with a pathspec list ready. |
| Transcripts get pruned | A new Stop hook, `turn-close.cjs`, writes the closing `Next` line to a per-repo ledger. The transcript tail is only a fallback. |
| Sessions rooted at `C:\Projects` that cd into repos | `turn-close` files ledger rows under every repo the turn's `FileModified` bus events touched. |
| Owner unknown | The rule edit adds `Next (me\|you\|wait YYYY-MM-DD\|none):`. "go" runs only `me`. An untagged line is treated as `you`. |
| The forced-verify gate is dead | Confirmed: line 28 needs `STOP_GATE_MODE=enforce` (unset) and line 31 reads `evt.message`. The gate is replaced by the evidence-order check in `turn-close.cjs`, which starts in shadow mode. |
| A job exits 0 but writes nothing | An `expects:{path,maxAgeH}` contract per job in `jobs/install.cjs`, read by both the doctor `jobs` check and the digest. |
| A red canary re-runs on every start | Confirmed at `guard-canary.ps1:15` (the throttle applies only when `$prev.ok`). Fix: a 60-minute red throttle that replays a cached banner. |
| The 4 h throttle is noisy across sessions | Replaced by an evidence hash in `seen.json`: an item shows again only when its evidence changes. An item that stays NEXT for 3 days with no action drops one rung. |
| Wrong NEXT erodes trust | Reason chip on NEXT. "Taken" counts only when the detector reads green (verified flip). Self-demotion. Only Wes's click restores a kind (one-way loudness). |
| Clean verdicts are never seen failing (L1) | Each digest run sweeps a fixture with 5 planted faults. Below 5 of 5, every "clean" line reads UNVERIFIED. |
| "go" collides with a live sibling | The go injection orders scope-lock first. A commit takes only this session's files, by pathspec. |
| Outbound action after reading untrusted content | Taint cap: a session that read outside content cannot push on "go". Push in a repo whose push deploys is a hard stop. |
| CI under Task Scheduler has no `GITHUB_TOKEN` | The scheduled run skips CI ("ci: skipped (scheduled, no session env)") and keeps the previous rows with their age. Session-spawned refreshes fetch CI. |
| `sessionTitle` unverified | Step 0 checks it on a real session. If 2.1.319 does not render it, the field is dropped in step 1. |
| Interactive volume collapsed (about 5 sessions a week) | Cost scales down with volume. T0 repairs run in the 06:50 digest with zero sessions, so the harness heals even on days Wes opens nothing. |
| Rejected grafts | Grouping `history.jsonl` into request families: rejected, because November has 9 prompts and the take-rate ledger measures the same thing directly. Discuss lock in scope-lock: rejected, because the regex blocks real tasks; the go regex matches whole prompts only, so "thoughts?" never starts NEXT. Timebox Mod: deferred, because the Mods layer is red. BEL through `terminalSequence`: deferred, because the field is unverified on 2.1.319 and the existing Stop sound hook stays. Medic's approve-merge-push and post-commit trigger: rejected, because a public push on one click is too risky and T0 runs only when no harness session is live. |

### 2.1 Files

| File | Status | Role |
|---|---|---|
| `engine/hooks/opening-move.cjs` | new (frozen glob `engine/hooks/*.cjs`, relock) | SessionStart brief. Also runs in the CHAIN with `exportedMain` (ledger plus go binding). Exports `main`, `rank`, `HARD_STOP_RE`. |
| `engine/hooks/turn-close.cjs` | new (frozen, relock) | Stop: writes the Next ledger, records evidence, runs the verify check (shadow first). |
| `engine/hooks/forced-verify-stop-gate.cjs` | deleted (a hard stop: confirm in-session at step 2) | Dead gate. Doctor `orphan-hooks` would fail if it were only unwired. |
| `engine/hooks/prompt-dispatch.cjs` | edit CHAIN | Add `{ file: 'opening-move.cjs', exportedMain: true }` directly after `wakeup-guard.cjs`. |
| `engine/hooks/guard-canary.ps1` | edit (frozen, relock) | Red throttle, per-leg notes, banner narrowed when only Mods is red. |
| `engine/hooks/tests/opening-move-probe.cjs`, `turn-close-probe.cjs` | new | Fixture probes. |
| `jobs/opening-move-digest.cjs` | new | Detached digest, T0 repairs, fixture sweep. |
| `jobs/install.cjs` | edit | `expects` per job, an `EXPECTS` export for ARG_REWRITES jobs, new JOBS entries `OpeningMoveDigest` and `DailyDistill`. |
| `engine/doctor/doctor.cjs` | edit check `jobs` | Fails on a stale artifact. |
| `tools/gitradar/gitradar.cjs` | edit last line | `main();` becomes `if (require.main === module) main(); module.exports = { scanAll, scanRepo };` |
| `tools/dashboard/dashboard.cjs`, `dashboard.html` | edit | Today tab, routes, `dashboard-url.txt`. |
| `engine/setup/first-run.cjs`, `engine/tests/reg-hooks.cjs` | edit | Wiring plus assertions, in the same commit. |
| `core/rules/global-rules.md` | edit | ADHD rule 3 plus a How to Work bullet (§2.8). |
| `docs/opening-move.md`, `README.md` (hooks table, Context group; jobs table) | new/edit | Docs. |

State lives in `~\.claude\state\opening-move\`:
- `repos\<key>.json`. The key is the repo toplevel, lowercased, with `[^a-z0-9]` replaced by `_`. Shape: `{repo, ring:[{session,transcript_path,cwd,ts,source:'prompt'|'stop',touched:[paths],tainted:bool}] (max 5), next:{text,owner,waitUntil,ts,session}, lastTest:{cmd,isError,ts}, lastBrief:{ts,kind,hash}}`
- `sessions\<sid>.json`: `{briefNext:{text,owner,kind,ts}, goUsed, blockedForPromptSeq}`. Rows older than 7 days are removed.
- `ledger.jsonl`: `{ts,repo,kind,hash,outcome:'shown'|'taken'|'ignored'|'still-open'|'go'|'auto-fixed'|'auto-fix-failed'|'auto-demoted'}`, trimmed to 90 days.
- `seen.json`: `{hash: lastShownIso}`.
- `mutes.json`: `{all:false, repos:{key:true}, items:{hash:untilIso}, kinds:{kind:'demoted'|'restored'}}`.
- `settings.json`: `{verifyGate:'shadow', repair:true}`.
- `digest.json`, `digest.lock` (`{pid,ts}`, stale after 10 min), `turn-close.jsonl`, `sample-agnostic-ai.txt`.

### 2.2 SessionStart: `opening-move.cjs`

**Wiring.** Through `wireAgentHooks` in `first-run.cjs`, the same pattern as the delegate guard: `SessionStart` group `{ matcher: 'startup|clear|compact', hooks: [{ type:'command', command: node "~/.claude/hooks/opening-move.cjs", timeout: 5 }] }`, exactly once.

**Gates.** All are fs-only, and the hook exits 0 every time.
- Runs only when `process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'`. Under any other value (`sdk-cli` for headless runs, cron, workflow agents) stdout stays empty.
- `source:'resume'` prints nothing.
- `OPENING_MOVE=off`, or `mutes.all`, or a mute on this repo, gives only additionalContext `[opening-move] off (dashboard toggle)`.
- Repo: walk up from `payload.cwd` looking for `.git`. If none is found (for example `C:\Projects` or home), fleet mode: the top 3 repos from `digest.repos` by gitradar severity, one line each, with NEXT taken from the top one.

**Sources.** Each prints its count (L2).
- A. Three parallel `execFile('git', …, {windowsHide:true, timeout:600})` calls: `log --since=<ring[0].ts> --format=%h%x09%ae%x09%s`, `status --porcelain=v1` (plus `fs.stat` on each dirty path to find the oldest), and `rev-list --count @{u}..HEAD`. Commits whose author email is not this repo's `user.email` appear only as a count and short sha, never their subject.
- B. `repos\<key>.json`: ring, `next`, `lastTest`, `touched`. A ring row from another session less than 10 minutes old gives a LIVE SIBLING line. When `next` is missing, read the 256 KB tail of `ring[0].transcript_path`, the same read `opus-handoff-inject.cjs` does.
- C. `digest.json`. Older than 60 minutes: spawn `node jobs/opening-move-digest.cjs` detached (`stdio:'ignore'`, `windowsHide`, `unref`, env `OPENING_MOVE_FROM=session`) behind `digest.lock`. The brief says "digest: 74 min old (refresh started)".
- D. Half-done markers:
  - the newest `~\.context-handoff-bundles\index.json` entry with this `repo_root`, created after `ring[0].ts` and less than 7 days old
  - unchecked `- [ ]` items in `<repo>\.agents\memory\{plans,tasks}\*.md` modified in the last 14 days
  - `post-edit-diagnostics.jsonl` rows with `ok:false` whose file mtime is unchanged
  - files in `~\clawd\agent-comms\inbox\` whose name or first line names the repo

**NEXT ladder.** `rank(state)` is a pure export used by the probe and the fixture. First match wins. Text comes from fixed templates filled with numbers, shas and repo-controlled names only.

| Rung | Kind | Condition | Template | Owner | Est |
|---|---|---|---|---|---|
| 1 | ci-red | digest ci row for this repo and branch is `failure` | `CI failed on <branch> at <sha> (<workflow file>, run <id>, <age>): read the failing log and fix it.` | me | 10 min |
| 2 | tests-red | `lastTest.isError` and no passing test since | `Last test here failed (<cmd>, <age> ago): re-run and fix.` | me | 5 min |
| 3 | resume | `next` less than 72 h old and owner `me` | the stored text, at most 160 chars | me | (none) |
| 4 | handoff | marker D1 | `Load handoff <slug> from <date> (/handoff-load <slug>).` | me | 2 min |
| 5 | syntax-left | marker D3 | `<file> was left with a syntax error at <time>.` | me | 2 min |
| 6 | commit-scoped | `ring[0].touched` paths still dirty | `Commit the <n> files the last session edited (<up to 5 names>) by pathspec; <m> other dirty files left out. I draft the message.` | me | 2 min |
| 7 | unpushed-clean | clean tree, ahead > 0 | `Push <n> commits on <branch>.` In agnostic-ai: `npm run doctor at 15 of 15, then git push and git push claude-harness.` | me, but `you` if the repo deploys on push (`vercel.json`, `.vercel/`, `render.yaml`, `netlify.toml`, `fly.toml`, `.github/workflows/*deploy*`) | 1 min |
| 8 | harness-red | digest red items (§2.5), only when the repo is agnostic-ai or `~/.claude` | per item | me | 5 min |
| 9 | stale-dirty | oldest dirty file older than 7 days | `Decide the <n> files left since <date>: commit, stash or drop; I draft the message.` | me (draft only) | 3 min |
| 10 | open-task | marker D2 | the first unchecked item | me | (none) |

Rules applied to the ladder:
- **Owner `you`**, at any rung, shows as `LEFT FOR WES:` and is never NEXT.
- **Owner `wait`** stays hidden until `waitUntil`.
- **Hard-stop filter.** `HARD_STOP_RE = /\b(deploy|publish|release|migrat\w*|force[- ]?push|push\s+--force|send|post|email|tweet|dm|delete|drop|rm\s+-rf|dns|billing|stripe|clerk|render|neon|invite)\b/i`. A match rewrites NEXT to `prepare <x>; <x> stays yours` and forces owner `you`. It applies to every NEXT, including a stored Next line.
- **Demoted kinds** become a dim `also:` line.
- **Stale-top.** The same hash as NEXT at the first session of the day on 3 consecutive days with no `taken` drops below the next matching rung for 7 days.
- **Bankruptcy.** D-markers and stale-dirty items whose evidence has not changed for 21 days are archived and shown as a count.
- **Harness items outside harness repos** show one `harness:` line when their evidence hash is new in `seen.json`. The exception is guard-class (a security leg false), which shows in every session.

**Output.** One JSON object on stdout. The `sessionTitle` placement is confirmed at step 0.

```
systemMessage:   Opening move, agnostic-ai: 2 red, 1 fixed for you (rules-drift). Type go to start: Mods canary leg validate-claude-runtime, about 5 min.
sessionTitle:    agnostic-ai master, 2 red            (only when red > 0)
additionalContext (cap 1,400 chars; compact source: RED + NEXT only, cap 300, only if red > 0 or NEXT owner is me):
[opening-move] agnostic-ai @ master 05c3810. Built in 140 ms: 3 of 3 git calls, 2 ledger rows, digest 41 min old (8 of 8 sources, fixture 5 of 5).
SINCE last session here (4 h ago): 1 commit by another session (05c3810), not pushed.
LIVE SIBLING: a session prompted here 29 s ago. Arm scope-lock on your files before editing.
FIXED FOR YOU: rules-drift (port: 1 would change, now 0; doctor rules-drift ok).
LEFT OPEN: .agents/memory/context/ untracked, 51 d. Last session's Next (you): "Push 05c3810 after the tournament finishes."
RED: Mods canary leg validate-claude-runtime false (0 errors listed, Claude 2.1.319; --repin is refused while any leg is red). NightlyMeditation: latest-line.txt 51 d old (limit 26 h), last result 1.
NEXT (me) [harness-red, rung 8, 51 d]: find why claude plugin validate ~\.claude\mods\claude-runtime --json returns success not true with 0 errors on 2.1.319, fix it, then node ~\.claude\mods\canary.cjs until 8 of 8 legs ok. About 5 min.
USE: Wes's prompt wins. "go", "continue", "next", "resume" or a greeting means start NEXT now. Otherwise do his task, and if NEXT is still open make it your closing Next line. Do not re-measure what this brief measured. A you-owned or hard-stop item is prepared (action, environment, side effects, rollback), never executed.
```

- **Clean repo:** additionalContext `clean: 0 dirty, 0 unpushed, CI green 41 min ago, 0 of 10 NEXT rules matched (fixture 5 of 5)`, with no systemMessage and no title. If the fixture is below 5 of 5: `clean (UNVERIFIED: fixture 4 of 5)`.
- **Overflow:** `+N more on the dashboard Today tab`. The URL is appended only when `~\.claude\state\dashboard-url.txt` names a live pid.
- **Writes:** `sessions\<sid>.json.briefNext`, `lastBrief`, a ledger row `shown`, and the evidence hash into `seen.json`.
- **Judging the previous NEXT:** if the previous `lastBrief` condition now reads green (the same detector), it is `taken`. If unchanged with no commits since, it is `ignored`. Otherwise `still-open`.
- **Demotion:** a kind with 10 or more `shown` in 14 days and a take rate below 20% gets `mutes.kinds[kind]='demoted'`. Only the Restore button reverses it.

### 2.3 CHAIN: `opening-move.cjs` main on UserPromptSubmit

`main(evt)` returns an additionalContext string, the same contract as `wakeup-guard.main`.
1. If `CLAUDE_CODE_ENTRYPOINT !== 'cli'` or `require('./wakeup-guard.cjs').isMachineTurn(evt)`, return `''`.
2. Append a ring row `{source:'prompt'}` to `repos\<key>.json` (1 to 3 ms).
3. If the previous `turn-close.jsonl` row for this session has `wouldBlock:true` and this prompt matches `/\b(test|verify|did you (run|check)|run it|check it|prove)\b/i`, append `{nudged:true}`. This is the shadow precision measure.
4. Go binding:
   - On the session's first human prompt, the whole prompt matching `/^\s*(go|go ahead|continue|next|resume|do it|yes|ok|start|what'?s next\??|hi|hey|morning)\W*$/i` binds to `briefNext`, or to the repo `next` if it is less than 72 h old.
   - On a later prompt, the same regex without the greetings binds to the repo `next` this session's Stop wrote less than 6 h ago.
   - Owner `me` injects: `[opening-move] Wes said "go": start NEXT now: "<text>" [<kind>]. Say in one line what you are doing, then do it.`
   - Owner `you` injects: `[opening-move] Wes said "go", but NEXT is his: "<text>". Prepare it (action, environment, side effects, rollback) and stop.`
   - A sibling ring row less than 10 minutes old appends: ` A sibling session is live here: arm scope-lock on the NEXT files before editing.`
   - A session marked tainted appends: ` This session read outside content: no push, no outbound step.`
   - It fires at most once per bound NEXT, and writes a ledger row `go`.

### 2.4 Stop: `turn-close.cjs`, which replaces `forced-verify-stop-gate.cjs`

**Wiring.** One `Stop` group `{hooks:[{type:'command', command: node "~/.claude/hooks/turn-close.cjs", timeout: 5}]}`. It is synchronous, because enforce mode returns a decision. `first-run.cjs` removes any group whose command matches `/forced-verify-stop-gate/`. Net Stop spawns: 0 added.

1. Runs only when the entrypoint is `cli`. Otherwise it exits 0 silently.
2. Text: `payload.last_assistant_message`. If that is absent, the last assistant text from a 256 KB transcript tail. Step 2 captures one real payload to confirm the field.
3. Parse the last match of `/^\s*Next\s*(?:\((me|you|none|wait\s+(\d{4}-\d{2}-\d{2}))\))?\s*:\s*(.+)$/im`. Untagged means `you`. Write `next` to the repo with the most `FileModified` paths this turn (cwd repo on a tie). Every touched repo gets a ring row `{source:'stop', touched, tainted}`.
4. Bus evidence from `~\.claude\mods\state\events\<session_id>.jsonl`:
   - Read the 512 KB tail. If it holds no `PromptSubmitted`, read the whole file up to 8 MB. Above that, skip with "bus: too large".
   - Events used: `FileModified{path}`, `ToolRequested{tool,tool_use_id,args}` (args may be a JSON string or an object), `ToolCompleted{tool_use_id,isError}`, `SubagentStarted{background}`, `SubagentCompleted`.
   - `lastEdit`: the max `seq` of a `FileModified` with an extension in `.cjs .js .mjs .ts .tsx .py .ps1 .sh .go .rs`.
   - Verify: a `ToolRequested` Bash or PowerShell call whose command matches `/\b(npm (run )?(test|lint|build|typecheck|doctor)|node --test|node \S*(probe|test|reg-)\S*|pytest|vitest|jest|cargo test|go test|tsc|eslint)\b/`, with `seq > lastEdit` and a matching `ToolCompleted.isError === false`.
   - Write `lastTest`.
   - Tainted: any `ToolRequested` whose tool matches `/^(WebFetch|WebSearch|mcp__)/`, or a Bash/PowerShell call whose args match `/declick (web|run)|curl\s+https?:|\bmole\b/`.
5. Verify check:
   - **Skips:** no code edits this turn; `payload.stop_hook_active`; more background `SubagentStarted` than `SubagentCompleted` since the prompt; `blockedForPromptSeq` equal to the current prompt seq.
   - **Shadow** (the default): append `{ts,session,repo,edits,verifies:0,wouldBlock:true}` to `turn-close.jsonl`.
   - **Enforce** (Today toggle only): `{"decision":"block","reason":"[turn-close] You edited <n> code files after your last passing check (<cmd or none>). Run the narrowest test that exercises <file>, read the output, then finish."}`, exit 0, at most once per human prompt.
   - **Auto-quiet:** if 2 of the last 5 blocks were followed within 120 s by a human prompt matching `/^(stop|no|skip|don'?t|leave it)\b/i`, set `verifyGate:'shadow'` and log `auto-demoted`.
6. Missing bus file: steps 4 and 5 log "bus: 0 events (mods layer down)". The Next ledger is still written.

### 2.5 Digest: `jobs/opening-move-digest.cjs`

Each source is written as `{ok,count,ms,error}`:
- **doctor:** `require('../engine/doctor/doctor.cjs').run()` in process.
- **canary:** `guard-canary-status.json` plus `~\.claude\mods\state\canary-leg.json`, split per leg. A false security leg (`secret-guard-denies-canary`, `model-guard-denies-modelless`, `gate-freeze-denies-project-edit`, `frozen-guards-match-lock`, `slopsquat-denies-unknown-package`, `hooksPath-set`, `pre-commit-exists`, `hook-targets-exist`) is guard-class. A false Mods leg is named, with the note that starts with `<leg>:`.
- **jobs:** one PowerShell `Get-ScheduledTaskInfo` call over `JOBS` plus `ARG_REWRITES` plus the `EXPECTS` names, plus an mtime check on each `expects.path`.
- **ci:** only when `OPENING_MOVE_FROM=session`: `gh run list -R <owner/repo> -b <branch> -L 1 --json conclusion,status,headSha,workflowName,databaseId,createdAt`, for at most 15 repos with commits in the last 14 days. Otherwise it is skipped and the old rows are kept with their age.
- **repos:** `require('../tools/gitradar/gitradar.cjs').scanAll()`.
- **hook-errors:** rows with `errors` in `~\.claude\state\prompt-dispatch.jsonl` over the last 24 h.
- **learning:** mtime of `storage/distill-PROPOSAL.md`.
- **fixture:** see below.

**Expects contracts** in `jobs/install.cjs`. Add `expects` to each JOBS entry, and `const EXPECTS = { NightlyMeditation: {...} }` exported beside `JOBS` and `ARG_REWRITES`:

| Job | Path | maxAgeH |
|---|---|---|
| HarnessParitySync | `~/.claude/logs/port-daily.log` | 26 |
| ClaudeErrorLog | `~/.claude/logs/errorlog/harvest.log` | 26 |
| CronwatchDaily | `tools/cronwatch/cronwatch.html` | 26 |
| Harness Health Monthly | `~/.claude/harness-health-last.txt` | 768 |
| NightlyMeditation (EXPECTS) | `~/.claude/meditations/digests/latest-line.txt` | 26 |
| DailyDistill (new) | `storage/daily-distill.log` | 26 |
| OpeningMoveDigest (new) | `~/.claude/state/opening-move/digest.json` | 26 |

- Reapers and WesErrorLog carry no contract and are counted as "no contract".
- New JOBS entry `DailyDistill`: `{ execute:'pwsh.exe', args:'-NoProfile -ExecutionPolicy Bypass -File "<W(jobs/daily-distill.ps1)>"', note:'daily 07:00: promotion ladder -> proposal', expects:{...} }`.
- New JOBS entry `OpeningMoveDigest`: `{ execute: process.execPath, args:'"<W(jobs/opening-move-digest.cjs)>"', workingDirectory: ROOT, note:'daily 06:50: opening-move digest and T0 repairs', expects:{...} }`.
- **Doctor `jobs` check:** keeps the retired-path test. It also returns `ok:false` with `STALE <name>: <file> <n> d old (limit <h> h)` for each stale artifact, and prints `<n> jobs with contracts, <m> fresh`.

**T0 repairs** (`REPAIRS` const). The argv arrays are fixed, and the `sync` and `port` commands are read from `package.json` `scripts` at runtime (each must start with `node `) and split into argv:

| Finding | Action | Verified by |
|---|---|---|
| doctor `rules-drift` fail | `scripts.sync`, then `scripts.port` | doctor `rules-drift` ok |
| doctor `links` fail | `scripts.sync` | doctor `links` ok |
| install `DIFFERS` | `node jobs/install.cjs --apply` | output contains `0 differ` |

Repair rules:
- **Preconditions:** `settings.repair !== false`; `OPENING_MOVE_REPAIR !== 'off'`; no ring row less than 10 minutes old in the agnostic-ai or `~/.claude` ledger.
- **Limits:** one attempt per finding per run, two per 24 h. After that the finding becomes harness-red with "auto-fix failed twice".
- **Ledger:** `auto-fixed` or `auto-fix-failed`, with before and after counts. Port is the same operation HarnessParitySync already runs unattended.
- **Probe:** fails if the allowlist contains `--force`, `--lock` or `--repin`.
- **Never repaired:** guard-class legs, frozen-lock drift, `settings.json`, test failures. These go to NEXT only.

**Fixture sweep.** Rebuilt each run under `%LOCALAPPDATA%\opening-move\canary`. It plants 5 faults and runs `rank()` over each:
1. a dirty file with mtime set back 8 days (expects stale-dirty)
2. one commit ahead of a local bare remote (expects unpushed-clean)
3. a fake job contract whose artifact is 3 days old (expects a job-stale red)
4. a ledger `next` reading "deploy the app" (expects `prepare`, owner `you`)
5. a ci row `{conclusion:'failure'}` through the ci parser (expects ci-red)

The result is `digest.fixture={found,of:5,missed:[...]}`.

**Harness-red templates:**

| Item | Template |
|---|---|
| Mods leg false | `Mods canary leg <leg> false (<note>); --repin is refused while any leg is red. Diagnose <leg>, then node ~\.claude\mods\canary.cjs until all legs ok.` |
| Guard leg false | `GUARD <leg> is not denying: do not trust guarded operations; fix from an agnostic-ai session.` (every session) |
| Stale job | `<job>: <file> <n> d old (limit <h> h), last result <code>.` |
| Distill | `distill: proposal <n> d old; DailyDistill <registered\|missing>.` |
| Doctor | `doctor <id> FAIL <after auto-fix | no auto-fix>: npm run doctor, fix <id>.` |
| Fixture | `opening-move fixture missed <names>.` |

### 2.6 `guard-canary.ps1` (frozen; relocked in the same commit)

1. After line 15, add: `if ($prev -and -not $prev.ok -and $prev.banner -and ([datetime]::UtcNow - [datetime]$prev.ranAt).TotalMinutes -lt 60) { Write-Output $prev.banner; exit 0 }`
2. Replace the notes regex filter with `$missing += @($mods.notes | Where-Object { $leg = ($_ -split ':',2)[0].Trim(); $mods.results.PSObject.Properties[$leg] -and -not $mods.results.$leg })`
3. Build the banner lines into `$banner` and store `banner = $banner` in the status JSON.
4. When `mods-layer-healthy` is the only false result, drop the "GUARD CANARY FAILED... safety guard is not enforcing" sentence. Print the MODS line only when the stdin payload `cwd` is under `C:\Projects\agnostic-ai` or `~\.claude`. Read stdin with `[Console]::In.ReadToEnd()`.

### 2.7 Dashboard Today tab

**Server** (`tools/dashboard/dashboard.cjs`):
- `server.listen` callback (line 759) writes `~\.claude\state\dashboard-url.txt` as `{"url":"http://127.0.0.1:<PORT>","pid":<pid>}`.
- Routes. Every POST already passes the `authorized()` gate at line 543.
  - `GET /api/opening-move` returns `{digest, briefs:{<key>:{ts,text,kind,reds}}, mutes, settings, stats:[{kind,shown7,taken7,ignored7,open7,shown14,taken14,rate14,state}], verify:{wouldBlock7,nudged7,precision7}, nextCoverage:{finals,withNext}}`
  - `POST /api/opening-move/mute` with `{scope:'item'|'repo'|'all'|'kind', key, days:7|null, restore:bool}`
  - `POST /api/opening-move/settings` with `{enabled, repair, verifyGate:'off'|'shadow'|'enforce'}`
  - `POST /api/opening-move/refresh`: spawns the digest detached with `OPENING_MOVE_FROM=session`.

**Page** (`dashboard.html`): a first tab button `<button class="tab-btn" data-tab="today">Today</button>` before `overview`.
- Top line: `Digest 06:50: 8 of 8 sources, <n> items scanned; fixture 5 of 5. 1 fixed for you, 2 red, 0 muted.`
- Sections:
  - Red now: one row per item with [Mute 7 days]
  - Fixed for you: before and after counts
  - NEXT kinds table: shown/taken/ignored/open over 7 and 14 days, with [Restore] on demoted kinds
  - Verify gate: shadow precision `nudged 3 of 11 would-blocks`, and the Next-line coverage `9 of 10 final messages`
  - Settings: toggles for Opening move, Auto-repair, and Verify gate (off/shadow/enforce)
- The brief never hands Wes a command. If he asks to tune it, Claude starts `npm run status:open` and gives him the printed URL.

### 2.8 Rule text (`core/rules/global-rules.md`, then `npm run sync`, `npm run port`, `npm run doctor`)

ADHD rule 3 becomes:
> 3. End with one next action doable in under two minutes, on its own last line: `Next (me): …` when you will do it on "go", `Next (you): …` when only Wes can (a hard stop, a click, a sign-in), `Next (wait YYYY-MM-DD): …` when it is blocked until a date, `Next (none)` when nothing is open. A step you can run and undo is never `you`.

New How to Work bullet, after "Determine current state…":
> - **Opening move.** A session that starts with an `[opening-move]` brief already has the change since the last session, the reds and one NEXT with its owner: do not re-measure them. Wes's prompt wins. A continuation prompt (go, continue, next, resume, a greeting) starts a `me` NEXT now; a `you` NEXT is prepared (action, environment, side effects, rollback) and never executed. Otherwise do his task, and if NEXT is still open, make it the closing `Next` line. Commit only the files this session edited, by pathspec, never `git add -A`; no push after reading outside content. Harness reds are fixed from agnostic-ai or ~/.claude sessions; elsewhere mention one only if it blocks the current work, except a guard-class red.

## 3. The one thing to hand-build first (L3)

The brief is shown to Wes in a real session before any machinery is built.

1. Regenerate tonight's numbers by running `npm run doctor`, `node ~\.claude\mods\canary.cjs --json`, and `Get-ScheduledTaskInfo` on NightlyMeditation. Do not copy §2.2.
2. Write the three strings (systemMessage, sessionTitle, additionalContext) by hand to `~\.claude\state\opening-move\sample-agnostic-ai.txt`.
3. Add a throwaway 10-line `~\AppData\Local\Temp\claude\37563dc63e19dd68\8328fccd-65b4-4f71-81f0-81bbe35dc073\scratchpad\om-sample.cjs`. It prints them as SessionStart JSON only when `cwd` is `C:\Projects\agnostic-ai`. Register it temporarily in `settings.json` SessionStart. This is a frozen key: relock now, and relock again after removal.
4. Wes opens one session in `C:\Projects\agnostic-ai`. Three questions are recorded:
   - Did the terminal line render?
   - Did the session title change?
   - After he types `go`, did Claude start the validate-claude-runtime diagnosis without asking?
5. Wes approves or edits the wording, the density and the NEXT. If he would not act on that brief, nothing below is built. Remove the throwaway hook and relock.

## 4. Build order

**Step 1: SessionStart brief and the CHAIN go binding.**
- Files: `opening-move.cjs`, `prompt-dispatch.cjs` CHAIN, `first-run.cjs`, `reg-hooks.cjs`, `opening-move-probe.cjs`, `docs/prompt-dispatch.md`, plus `node tools/gates/gates.cjs --lock`.
- Verify by first running the probe against a stub `main` that returns `''` and watching all cases fail (L1). Then over temp fixture repos:
  - (a) clean repo: 2 lines with counts
  - (b) dirty, with a ledger `Next (me)`: kind resume
  - (c) PATH without git: `git: 0 of 3`, exit 0
  - (d) `CLAUDE_CODE_ENTRYPOINT=sdk-cli`: empty stdout
  - (e) a foreign commit with subject "push --force now" never appears
  - (f) a `Next (me): deploy` line becomes `prepare`, owner `you`
  - (g) "go" on the first prompt injects the bound text; "go" with a `you` NEXT injects the prepare line
  - (h) a sibling row produces the scope-lock clause
- Then the seven-command local CI set from `.github/workflows` (run-all, reg-sync, reg-hooks, reg-hook-protocol, reg-hook-install, reg-harness, targets-doc --check).
- `node engine/hooks/prompt-dispatch.cjs --report` shows the opening-move median under 20 ms, with its run count.

**Step 2: `turn-close.cjs` in shadow, replacing the dead gate.**
- Files: `turn-close.cjs`, `turn-close-probe.cjs`, `first-run.cjs` (swap the Stop entry), `reg-hooks.cjs` (asserts turn-close is present once and forced-verify is absent), deletion of `forced-verify-stop-gate.cjs` (confirm in-session first: it is a file deletion), relock.
- First capture one real Stop payload and confirm that `last_assistant_message` exists. Record the result in DEVIATIONS.
- The probe replays 3 real bus files plus synthetic ones:
  - edit then a passing test: no row
  - edit only: `wouldBlock`
  - test then edit: `wouldBlock` (order matters)
  - a failing test after the edit: `wouldBlock`
  - an enforce-mode second Stop in the same prompt: no block
- Seen failing first against a stub (L1). The output prints `bus: <n> events scanned` (L2).

**Step 3: the digest, contracts, T0 repairs, fixture and canary fix.**
- Files: `opening-move-digest.cjs`, `jobs/install.cjs`, `doctor.cjs` `jobs`, `gitradar.cjs` export, `guard-canary.ps1`, `reg-hooks.cjs`, relock.
- Verify:
  - `node jobs/opening-move-digest.cjs` writes 8 sources, each with a count.
  - A run with PATH lacking gh gives `ci ok:false` while the other 7 stay ok.
  - `npm run doctor` jobs FAILS on NightlyMeditation (the known positive, 51 d). If it passes, the contract is wrong (L1).
  - The fixture prints `5 of 5`. Delete the planted mtime fault and it prints `4 of 4`... it must print `4 of 5` and mark clean UNVERIFIED (seen failing).
  - A planted port drift in a temp `AGNOSTIC_STORAGE` is repaired and verified green.
  - The allowlist probe fails when `--repin` is inserted.
  - Two consecutive starts with a red canary inside 60 minutes: the second replays the banner in under 1 s.
  - The agent registers `OpeningMoveDigest` (daily 06:50) and `DailyDistill` (daily 07:00) with `Register-ScheduledTask`, using the JOBS actions. `node jobs/install.cjs` then prints `ok OpeningMoveDigest` and `ok DailyDistill`.

**Step 4: rules and docs.**
- Files: `core/rules/global-rules.md` (§2.8), `docs/opening-move.md`, README hooks and jobs tables, `docs/ERRORS.md` entry "meditation dark 51 days under a green doctor jobs check".
- Verify: `npm run sync`, `npm run port`, then `npm run doctor` at `15 checks: 0 failed`.
- After 7 days, the Today tab's Next coverage reads at least 9 of 10 final messages (baseline 2 of 4).

**Step 5: Today tab.**
- Files: `dashboard.cjs`, `dashboard.html`.
- Verify:
  - Headless Playwright renders the tab with real digest rows.
  - Click Mute on one item; the next SessionStart says `1 muted` and omits it.
  - A POST without `x-dashboard-token` returns 403 (seen failing).
  - Setting the verify gate to enforce changes `settings.json`; the auto-quiet probe flips it back to shadow.

**Later step 6** (after 2 weeks of ledger data): `engine/hooks/session-dispatch.cjs` folds session-count, opus-handoff-inject and opening-move into one SessionStart process. Verify with `tools/hook-latency` before and after, and reg-hooks green.

## 5. Cost and fail-safe

| Where | Tokens | Seconds |
|---|---|---|
| Per tool call | 0 | 0 new spawns |
| Per human prompt (CHAIN) | 0, or about 50 once when "go" binds | 1 to 3 ms inside the existing dispatcher |
| SessionStart (startup or clear) | median about 200, cap about 350, cached after turn 1. About 1,000 token-equivalents over a 40-turn session | 1 new node spawn (0.1 to 3.1 s on this box, in parallel with the other hooks); git 111 to 125 ms |
| SessionStart (compact) | at most about 80, only if red or a `me` NEXT | same |
| Stop | 0 in shadow; about 60 per enforce block, at most 1 per prompt | 0 net spawns (replaces forced-verify); bus read under 50 ms on a 512 KB tail |
| guard-canary while red | saves one full canary run (two `claude plugin validate` calls with 90 s timeouts) per session start within 60 min | under 1 s replay |
| Digest (06:50 plus at most hourly when stale) | 0 model tokens | 20 to 40 s detached; T0 port adds about the HarnessParitySync duration; at most 15 gh calls, session-spawned runs only |

At about 5 interactive sessions a week, that is about 5k token-equivalents a week, less than one lean subagent spawn.

**Degradation:**
- Every source fails on its own and prints `<n> of <m>` with the reason. Nothing prints a bare OK.
- Every hook is wrapped in try/catch and exits 0; stdout is valid JSON or empty.
- With the Mods bus down, the verify and taint evidence are skipped and labelled, and the brief still runs.
- With the dashboard down, the brief omits the URL.
- An old digest triggers a background refresh and its age is shown.
- With gh unauthenticated: `ci: 0 of 15 (no auth)`.
- A fixture miss marks clean lines UNVERIFIED.
- Untrusted strings never enter the brief: only counts, shas, ages, and repo-controlled file and workflow names. There is no outbound channel, so the trifecta cannot form.

**Dials, from finest to coarsest:**
1. Mute 7 days per item.
2. Restore or demotion per kind (demotion is automatic; only a click restores).
3. Off for this repo.
4. Auto-repair toggle.
5. Verify gate off/shadow/enforce.
6. Master toggle, or env `OPENING_MOVE=off`.
7. Full removal: the SessionStart entry, the Stop entry, the CHAIN line, and `Unregister-ScheduledTask OpeningMoveDigest`.

## 6. Runners-up worth scheduling later

1. **Medic, remainder** (197): build its Repairs page, the T1 worktree fixes and the nightly Sonnet diagnoser only when the Today tab's `auto-fix-failed` rows reach 3 or more in 14 days, which shows that T0 is not enough.
2. **Loose Ends commit tray** (191): build it once `turn-close` shadow precision is at least 80% over 14 days and the verify gate has run in enforce mode for a week without auto-quiet.
3. **Threadkeeper timebox** (187): add the 60/120-minute timebox Mod note once the Mods canary has been green for 7 days in a row.
4. **Standing Orders family mining** (182): rebuild its request families when `history.jsonl` exceeds 300 human prompts in a month again. Feed the families into which NEXT kind leads.

Files changed by this step: none. Sources re-read: prompt-dispatch.cjs, forced-verify-stop-gate.cjs, wakeup-guard.cjs, opus-handoff-inject.cjs, session-count.cjs, guard-canary.ps1, jobs/install.cjs, jobs/daily-distill.ps1, port-daily.ps1, errorlog/harvest.sh, meditation/run-nightly.sh, doctor.cjs, mods/canary.cjs with canary-leg.json and guard-canary-status.json, dashboard.cjs and dashboard.html, first-run.cjs, reg-hooks.cjs, gitradar.cjs, gate-manifest.json, the ~\.claude\settings.json hooks, global-rules.md, and the Mods bus event kinds (415 files).

Not verified: the Stop field `last_assistant_message` on 2.1.319 (step 2 captures one real payload), the placement and rendering of `sessionTitle` and `systemMessage` (step 0 checks them on a real session), and the exact commands of the seven-command CI set (read from `.github/workflows`).