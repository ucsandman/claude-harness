# Errors and lessons

## 2026-09-29 - The routing Mod never captured a spawn's overhead and priced the whole run instead

- **Symptom:** the Mod denied two Sonnet figure workers at "~487,680 overhead
  (learned overhead n=14)" when a lean spawn arrives at about 17k. Its ledger
  had `overhead` 0 in 34 of 34 measured rows since the 2026-09-18 split, and
  learned overheads of 2.17M (opus-owner), 487k (sonnet-implementer) and 102k
  (haiku-scout). 31 of 56 Fable spawns that week went through on `SPAWN_OK`.
- **Root cause:** `budget.step()` captured overhead only while `!a.calls`, but
  on a live run `tool.call` counts the call before the `ModelStep` that paid
  for it arrives, so the capture never fired. `settle()` then fell back to
  `a.measured`, storing the whole run as overhead, which is exactly what the
  09-18 split was written to stop. Its tests stepped before counting the call,
  the one order that never happens live.
- **Fix:** the first step is always overhead (`a.steps === 1 || !a.calls`),
  settle never uses the total as an overhead sample, and `OVERHEAD_VERSION = 2`
  discards stored overhead samples from before the fix. New test replays the
  live order; it failed first, then passed (12/12). A fresh `claude -p` on
  Sonnet priced the same one-call haiku-scout dispatch at ~17,000 (prior lean),
  down from 25,580. Lesson: a test that feeds events in the order you assumed
  proves the assumption, not the code; replay the order the log shows.

## 2026-09-16 - Secret scanning covered two map keys and the docs promised the whole bundle

- **Symptom:** an independent security review of the engine embedded in Leg
  planted a token in the rules text, a hook command line, an MCP argument and
  an MCP url; `validate()` reported one problem, the env one. The four canary
  tests only planted tokens where the scan already looked.
- **Root cause:** `looksSecret` was written for `env` and `headers` values and
  never applied to free text or command lines; the bare-URL exemption also
  waved through a password in a connection string.
- **Fix:** `findSecrets`/`redactSecrets` over every field, `bundle.sanitize()`
  before every save (redact text, drop an unsafe handler or server with a
  warning), URL userinfo, query and path-token checks, and fixtures that plant
  a token in every place the scan must reach. A check never seen failing has
  been run, not verified: the new fixture is the failing case.

## 2026-09-06 - Two writers for one target file, and a personal tool that never came home

- **Symptom:** Codex's AGENTS.md flipped between two shapes depending on which
  job ran last; the repo's own registry had no Codex, Gemini or Antigravity
  target at all while the README promised a 16-client harness.
- **Root cause:** the repo's sync wrote rules files only, so a working
  Claude-to-Codex port (hooks with trust hashes, agents, prompts, skills, MCP)
  grew as a personal script under ~/.claude with this machine's paths and hook
  names hardcoded. When both wrote the same file they fought; when the repo
  dropped its Codex target to stop the fight, the public repo no longer did the
  thing it was for.
- **Fix:** the port engine (engine/harness) with one writer per file, a
  registry that carries every client surface, a policy file for exclusions,
  and adapters written against a contract with fixture-home tests.
- **Lesson:** a capability proven in a personal script is not shipped until it
  is data-driven and lives where the tests run. Every hardcoded machine fact in
  that script (a hook name, a skill list, a model slug) became a field in
  core/port.json or a value read from the target's own files.
- **Retro, one change each:** grep `engine/tests/` for a behaviour BEFORE removing it (two
  first-run tests went red after the flat-format hook path was deleted, found only when the
  suite ran); a test fixture that hardcodes a `C:/` path is not absolute on the Ubuntu CI
  legs (`path.isAbsolute`), so fixtures build paths from a temp dir; and a value that YAML
  reads as a flow sequence (`argument-hint: [text]`) must be quoted by the frontmatter
  renderer, which the staged diff against the live Codex prompts caught before the real apply.

## 2026-09-05 - Preserve shared lifecycle hook configuration

Claude's setup correction and Codex's stdout repair address different boundaries. Setup now leaves an existing lifecycle `hooks` object unchanged instead of adding a flat event key. Four fixture checks cover empty and populated Codex/Gemini configurations and guard-presence reporting. The new check failed against the previous installer and passed with the correction.

What worked: pausing the release when the operator identified another active session, then reviewing its separate installer change before including it. What did not: assuming a clean initial checkout meant no other session would begin writing later. Prevention: recheck the working tree immediately before staging and validate the combined state when another agent's completed work is included.

## 2026-09-05 — Codex rejected the pre-tool hook JSON

The Agnostic guard returned a top-level permissionDecision. Current Codex lifecycle hooks require that field inside hookSpecificOutput with hookEventName set to PreToolUse. This produced repeated invalid pre-tool-use JSON warnings even for benign commands. Internal decision tests passed because they inspected the flat object rather than the wire response.

The shared adapter now wraps decisions at the stdout boundary for Codex and Claude, preserving the existing internal decision dialect and other clients. Both guard runners also put denial reasons on stderr for exit code 2. The installed Codex command directly references this source, so the next invocation loads the repair without a config rewrite or disabling a hook.

What worked: replaying a harmless payload through the actual runner and comparing the response with the documented lifecycle envelope. What did not: testing only the internal return object. Prevention: the npm suite now includes eight real-process protocol checks covering both runners, Bash/MCP inputs, and allow/deny results. The new check was observed failing before the repair.

Wire contract: https://learn.chatgpt.com/docs/hooks#pretooluse

Verification: eight wire checks, 73 existing hook regressions, 13 sync regressions and Ruff passed. Generated target and orchestration documentation checks pass after regenerating the target table. The broader npm suite initially failed its obsolete assertion of 18 targets against a registry of 16 (27 passed, one failed). The operator explicitly approved correcting that assertion to 16 on 2026-09-05; the registry is unchanged. Package descriptions and the README now reflect the same count. Prevention: when intentionally removing a sync target, update the parity assertion and regenerate the target documentation in the same change.

All 530 Python tests also passed with `python -m pytest tests/ -q -p no:xonsh`. The default invocation crashed during plugin startup because the globally installed xonsh plugin requires a Windows console; excluding that unrelated plugin required no repository or test changes.

One line minimum every time something broke or a premise turned out wrong.
Full entries (symptom, root cause, fix) when it took more than one attempt.

## 2026-08-20 (review tournament)

- **`reg-hooks.cjs` died whenever port 3000 was busy.** `listen()` failures are
  `'error'` events, not promise rejections, so the `.catch` never saw them. Fix:
  ephemeral port. Lesson: same as the 7842 entry below — a fixed port in a test
  is a guess about someone else's machine.
- **Wrong premise: "no tool runs vulture, delete the whitelist."** The repo
  has no vulture step, but the machine's global pre-commit hook does, and the
  first commit of this release was blocked by 20 false positives (Textual
  `action_*`/`compose`/`on_print`, prompt_toolkit handlers, `to_dict`s). Fix:
  the whitelist is back as `.vulture_whitelist.py` (the hook's preferred name),
  pruned to real framework callbacks. Lesson: "nothing runs X" must include the
  global hooks in `~/.claude/git-hooks`, not just the repo's CI and scripts.
- **`launch.py` opened a different project's app.** Symptom: `python launch.py`
  brought up an unrelated local UI (hooop) instead of the command center. Root
  cause: another app already owned 7842, so `EADDRINUSE` took the dashboard's
  "already running" branch, which trusted the port instead of identifying the
  occupant, and `--open` launched a browser at it. Fix: every response carries
  an `x-agnostic-dashboard` header, the collision path HEAD-probes for it, and
  a foreign occupant means bind the next free port. The same fixed-port
  assumption in `start_companion_server` (returned failure on a busy 7843) got
  the same walk-up. Lesson: a hardcoded local port is a guess about someone
  else's machine — verify the occupant before reusing a port, and never print a
  URL you did not bind. This is the second time this bug shipped (see the
  distill digest entry about 7842 vs a Next.js dev server).

- **Dashboard POST routes were unauthenticated.** Symptom: nothing visible;
  found in a review. Root cause: the Python companion got an auth pass, the
  Node dashboard never did. Fix: token + loopback-origin gate on all POSTs,
  regression tests in `engine/tests/run-all.cjs`. Lesson: a second server in
  the same repo needs the same review as the first.
- **Fabricated "audit events" in the governance view** asserted a secret scan
  that never ran. Removed. Lesson: never seed a safety UI with placeholder
  results.
- **README claimed features the code did not have** (swarm "Implementer" and
  worktree isolation, interactive `launch.py`, `npm install` with no
  dependencies, `/multiline` in the TUI). Fix: docs rewritten from the code;
  `docs/targets.md` generated. Lesson: fact-check every README claim against
  source before a ship.
- **Bash heredoc mangled a JS string.** A `python - <<'EOF'` edit through the
  Bash tool turned `'\\n'` into a literal newline in
  `engine/skills/recommend.cjs` (SyntaxError). Fix: use the Edit tool for code
  edits on this machine.
- **`vulture_whitelist.py` imported gitignored `skills/definitions`** and three
  renamed classes, so it failed on a clean clone. Fixed at the time; the file
  has since been deleted along with the vulture pass.
- **`tools/errorlog --selftest` could not fail** (printed a check mark next to
  a literal `false`, exited 0). Fixed at the time; the tool has since been
  deleted — the command center is the only error surface.
- 2026-09-19 — Consolidation stage A replaced the Mods' hardcoded home paths with an environment read at module load; the hooks worker has no Node globals, so both Mods failed to load ("process is not defined") until a headless session after the fix proved the heartbeat. Lesson: a change to code that runs in another runtime is verified in that runtime before it ships, not by the unit tests beside it. A wrapper around `on()` was then refused by the validator (`$` only to top-level functions); each hook resolves the home itself.
- 2026-09-19 — The same stage copied a private research repository into `labs/` wholesale and published 32 transcript-derived data files for a day. Lesson: a directory copy from a private repository is scanned for data before the first push; the doctor's `data-files` check now blocks a recurrence. History still holds the blobs until the owner decides on a rewrite.
- 2026-09-19 — **"Claude is incredibly slow" was process spawn cost, and the Bash tool's login shell.** Symptom: every tool call took 15 to 30 s; a Bash tool call in a fresh session measured 31.6 s for an `echo`. Root cause, in layers: process creation on the machine was 10 to 30x slow and erratic (0.77 GB RAM free, three tsservers from the typescript-lsp plugin at 2.2 GB each indexing all of `C:\Projects`, orphan node sentinels; freeing 5 GB helped RAM but not spawn); every Bash tool call ran `bash -c -l`, and Git for Windows' `/etc/profile` forks ~14 times (5 to 14 s per call, never measured before); 56 hook commands, each a `bash -c` plus node or python, 15 of them on every Bash call. Prompt caching was fine, so the token audit was not where the time went. Fix: `tools/bash-noprofile` shim on `CLAUDE_CODE_GIT_BASH_PATH` (31.6 s to 4.2 s per call), typescript-lsp off, orphans killed, `tools/hook-latency` so the next pass starts with numbers. Three probes were lost to a shim that inherited handles instead of passing them: Claude Code spawns the shell detached, so the child wrote to a console nobody read and the tool said "(Bash completed with no output)". Lesson: before adding any hook or shell layer, time one process spawn and one empty login shell on the machine; the 2026-09-06 "a dispatcher buys nothing" verdict was true on a fast box and inverted on a slow one. Second lesson: a custom `CLAUDE_CODE_GIT_BASH_PATH` binary must pass std handles explicitly.
- 2026-09-19 — **Every saved workflow was unlaunchable after the fan-out guard shipped, and the by-name form kept failing after the fix.** Symptom: `Workflow({name: "tournament"})` denied with "no declared ceiling"; none of the four scripts in `workflows/` carried `// MAX_AGENTS:` because the guard postdates them. After the ceiling was added to `tournament.js`, the by-name launch was still denied while a local run of `agent-model-guard.cjs` on the same payload passed: the harness hands the guard a script resolved earlier in the session, so an in-session edit to a saved workflow is invisible to the name form. Fix: `tournament.js` declares its arithmetic (`lenses + judgeLenses + 1`) and throws above 30; relaunch with `Workflow({scriptPath: "C:/Projects/agnostic-ai/workflows/<name>.js", args})`, which reads the file fresh. Still open: `understand.js`, `adversarial-review.js`, `fix-findings.js` carry no ceiling; the verify stage in `adversarial-review.js` is the exact shape that queued 225 agents and needs a real cap, not a comment. Lesson: a new guard is applied to the saved shapes it governs in the same change, or the shapes stop working silently.
- 2026-09-19 — **Every prompt printed six "UserPromptSubmit hook timed out after 5s" lines, and a waiting session answered "Waiting." seventeen times.** Symptom: red timeout rows after each prompt in a sense-memory session running a tournament; the model woke on every PNG a Monitor watched, replied "Waiting.", and re-armed; 1.4M tokens in 45 minutes for 0 of 12 agents. Root cause: settings.json spawned eight UserPromptSubmit processes per prompt (seven node, one python) with 5 s budgets, and under ~30 concurrent sessions a bare node start measured 2.6 s and the python nudge 5.2 s, so every hook's output was discarded, including the guard that briefs a Fable session; each Monitor event is a prompt, so the set re-ran per wake-up. Fix: `prompt-dispatch.cjs` (one process, hooks in-process, 30 s budget), `wakeup-guard.cjs` (third consecutive machine wake-up: no text, stop the stalled task), `context-nudge.cjs` replacing the python, doctor `prompt-hooks` check, `first-run.cjs` wires the dispatcher. Lesson: a hook budget is set against the machine's worst spawn time, not its best, and N hooks on one event are one process; the 2026-09-06 note already said the dispatcher verdict inverts on a slow box, and this is that box. Second lesson: a Monitor that fires per file is the wrong grain when a workflow already notifies on completion.

- 2026-09-19 — **CI went red on all three legs the moment the prompt-hook consolidation shipped.** Symptom: `reg-hooks` 73 passed, 1 failed on ubuntu 18/22 and windows 22, "UserPromptSubmit must hold exactly one delegate-guard entry". Root cause: `first-run.cjs` now installs `prompt-dispatch.cjs` as the only UserPromptSubmit command, with `fable-delegate-guard.cjs` inside its CHAIN, and the regression test still asserted the wiring that change removed. The probe written for the dispatcher (`engine/hooks/tests/prompt-dispatch-probe.cjs`) passed, so nothing local caught it. Fix: the test asserts the shipped contract, one dispatcher entry and zero direct guard spawns on UserPromptSubmit, and was watched failing by pointing the installer back at the guard. Lesson: a change to how hooks are wired updates `reg-hooks.cjs` in the same commit; a new probe beside the new code does not replace the regression test that owns the old contract. Second lesson: the local full CI set is seven commands (`run-all`, `reg-sync`, `reg-hooks`, `reg-hook-protocol`, `reg-hook-install`, `reg-harness`, `targets-doc --check`), and `npm test` alone runs none of them.

## 2026-09-19 — foldlight: six hours, every gate green, every page empty
Ultracode plus a full spec plus four sequential multi-agent workflows with verify-and-fix loops ran six hours and drained the operator's usage; the output was six demo pages that passed silhouette, craft, token and copy linters and were visually empty (one headline, ten empty rules, one control). The harness had no wall-clock guard and no "has a human looked at the render" gate; the only guard that fired was the fan-out MAX_AGENTS check. Lesson: a linter written from a spec measures the spec; the operator judges the screen. Rule L3 added: hand-make one approved artifact before building the machine; stop at one hour with a render in front of the operator.

## 2026-11-08 — a backspace byte in the fan-out regex denied every saved workflow
`engine/hooks/agent-model-guard.cjs` declared its MAX_AGENTS regex as `|\bMAX_AGENTS\s*=`, but the `\b` had been written through a shell layer that turns `\b` into the literal byte 0x08, so the `const MAX_AGENTS = N` alternative could never match and only a numeric `// MAX_AGENTS: N` comment passed. `workflows/tournament.js` carries a prose comment plus the const, so the guard denied it; the probe passed because no case used the const form. Found when the first tournament of this session was blocked; the inline replay with a tiny payload printed nothing because the deny goes to stdout as JSON, which looked like an allow. Second defect behind it: none of the four saved workflows carried `# EST:` in their agent prompts, so the subagent-budget guard denied all twelve candidates once the first guard let them through, and `adversarial-review` and `understand` had no MAX_AGENTS declaration at all. Fixes: the byte replaced with `\b` (written via a script file, since the Bash tool re-mangles `\\b`), a probe case with the const form that the HEAD guard fails, `# EST:` on all eleven agent sites, MAX_AGENTS arithmetic and caps in both unguarded workflows, and the hook-wiring gate now finds settings.json in the Claude home. Lessons: a guard's deny arrives on stdout, so a replay's verdict is the JSON, never the exit code; a saved workflow is a hook target too and needs a probe that runs it through the guards after any guard change; never write a regex escape through the Bash tool, use Write or Edit. Third defect, found on the rerun: `Workflow({name})` served the saved script as it was when the session started, so the `# EST:` edits never reached the run (the snapshot under `workflows/scripts/` was byte-identical to the pre-edit file); the 12 candidates passed only through the budget guard's second-attempt anti-thrash allowance, and the judges, first attempt, were denied after 1.59M tokens of candidate work. A saved workflow edited mid-session must be relaunched by `scriptPath`, and a resume that must keep its cache changes only the prompts of the stages still to run.

## 2026-11-08 — meditation dark 51 days under a green doctor `jobs` check
`NightlyMeditation` ran every morning at 06:40 and exited 1 from 2026-09-19 to 2026-11-08; `~/.claude/meditations/digests/latest-line.txt` stayed at 2026-09-18 and `~/.claude/logs/meditation/` was never created. The task does not run `jobs/meditation/run-nightly.sh` directly: it runs `C:\Projects\discovery-loop\scripts\morning-research.py --mode meditation-context`, which transforms the runner's text through `install-morning-context.py` and pipes it to `bash -s`. That transformer anchors on the literal `CMD=(/c/`; the 2026-09-19 runner edit replaced it with `CMD=("$CLAUDE_BIN"`, so `transform()` raised `ValueError` every night before bash started, and nothing wrote a log. The doctor `jobs` check only asserts that task actions point at existing paths, so it stayed green for 51 days; the harvest and distill ran on nothing, and `~/.claude/history.jsonl` fell to 65 prompts in October and 11 in November, so there was little to learn anyway. Surfaced by the proactive-harness tournament's synthesis agent, confirmed live, and fixed in discovery-loop (`CMD_ANCHOR = 'CMD=("$CLAUDE_BIN"'`), verified by a `MEDITATE_DRYRUN=1` run of the transformed script. Lessons: a scheduled job needs an output contract (`expects: {path, maxAgeH}`) checked by the doctor, not a path check (Opening Move spec, step 3); a runner that another repo's wrapper rewrites by anchor must name that wrapper in a comment, so the next edit knows what it breaks.

## 2026-11-08 — the Mods adapter carried a reserved plugin name; the "stale cache" alarm beside it was false
Claude Code 2.1.319 refuses plugin names that start with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-` (they pass as Anthropic's own), so `claude plugin validate` on `engine/mods/claude-runtime` went red, the canary leg `validate-claude-runtime` with it, and four guards ran on classic fallback. Fix: renamed to `harness-runtime` (directory, both manifests, canary keys, liveness text, README, tsconfig, docs, example settings), `claude plugin marketplace update harness-mods`, uninstall of both plugins, reinstall adapter-first so it stays outermost; canary 8 of 8; a headless haiku session's heartbeat shows runtime=true, 9 of 9 capabilities, all four guards armed. While there, `diff -rq` showed the install-time copies under `~/.claude/plugins/cache/harness-mods/` differed from `engine/mods` in eleven files since 2026-09-16, and a side agent concluded seven weeks of Mod edits had never run. That was wrong, and the way to know was an experiment, not a diff: with `claudeVersion: "9.9.9"` planted in the cache copy of `canary.mjs` only, the next headless session's heartbeat reported the source's `2.1.274`, and `claude plugin update` says the same ("read from its folder: nothing to update; edits take effect at the next session start or /reload-plugins"). A folder-marketplace plugin runs from its folder; the cache copy is a dead snapshot even though `installPath` points at it. Lessons: `installPath` is not the load path for a folder marketplace, so a cache-versus-source diff measures nothing; before declaring that code "never ran", plant a marker only one copy can carry and read it back from the running system. The CLI leaves `cache/harness-mods/claude-runtime/0.2.0` behind after the uninstall; it is dead and can be deleted by hand.

## 2026-11-09 — a digest probe re-pointed a real scheduled task
The first run of `engine/hooks/tests/opening-move-digest-probe.cjs` exercised the T0 repair path (`node jobs/install.cjs --apply` after an install-differs finding) under a temp home, and the repair ran against the machine's real Task Scheduler: "Harness Health Monthly" had its output redirect re-pointed at the temp folder. The implementer caught it the same hour; `--apply` restored Execute and Arguments, `install.cjs` reads "0 differ", and the task runs monthly (last 11-01), so it never ran on the wrong path. Fixes: repairs refuse to run when the home has no `.claude/settings.json` (a temp home never does), the probe runs with `OPENING_MOVE_REPAIR=off`, and the repair test uses a stub root with stubbed sync, port and install under a temp `AGNOSTIC_STORAGE`. Lesson: a test that drives a repair path lists every side effect the repair can have outside the repo (Task Scheduler, `~/.claude`, the ported clients) and stubs or disables each before the first run; a temp home does not sandbox Task Scheduler.

## 2026-11-09 — a carry-over fix to the hard-stop filter opened a hole its brief had asked for
Step 1 of Opening Move had one real false positive: `HARD_STOP_RE` fired on file names such as `post-edit-diagnostics.cjs` and `release-notes.md`, so a stored Next that only edited those files was shown as LEFT FOR WES. The step 2 brief said "path-like tokens (anything containing /, \ or a .ext) do not trip the filter", and the implementer did exactly that. The reviewer caught `send/post the launch note` and `run scripts/deploy.sh` becoming owner `me`; the refix narrowed the exemption to tokens with a code extension whose basename is not the hit word, and the second verifier then ran the same inputs against HEAD and found `run deploy-prod.sh`, `bash scripts/release-v2.sh` and `run migrate-db.ts` rank as NEXT (me), which "go" would have started. HEAD had never let them through. Ruling: the exemption fails closed. A hit inside a path-shaped token is exempt only when the token is being edited or read (the preceding word is an edit verb or preposition, a comma list, or another file), never when the text is bare, or when `run`, `node`, `bash`, `sh` or `./` appears before it. Lesson, as a rule for this repo: a fix to a safety filter ships with a probe case that replays the same inputs through HEAD's copy of the filter and asserts every item HEAD refused is still refused; the verifier's "regression vs HEAD" check is what caught this, so it is now part of the opening-move probe (case m, 21 you-strings, 13 me-strings) rather than a verifier's initiative.
