# Post-mortem: the declick 0.3.1 launch session, 2026-09-03

Four hours from "is this good enough for Hacker News" to a published 0.3.1, of which roughly two and a half were spent on four rounds of fixes for defects a single careful pass should have closed. This is what happened, measured from the session transcript, and what changed in the harness because of it.

## Timeline

| When (elapsed) | What | Outcome |
|---|---|---|
| 0:00 to 0:50 | Readiness review, README quickstart, demo GIF, site headline, GitHub About | Fine. Shipped. |
| 0:50 to 1:30 | Wes asks "have we tested thoroughly?" Two QA agents run the published 0.3.0 on Windows and Linux against real public specs | Right call. Found that no real spec compiled, the YAML parser dropped data silently, Node 18 stack-traced, export/import did not round-trip, plus a dozen contract violations. |
| 1:30 to 2:15 | Fix pass 1: fix-findings workflow, 17 agents, 8 findings by file | Most fixes landed. Reviewers flagged three findings as "fixed at one call site only". Verify stage timed out on a hung test. |
| 2:15 to 3:30 | Fix pass 2: 17 agents, 8 findings from the Linux report | A reviewer ran `git stash` on the shared tree to see a red run; the pop conflicted; a 25-file fix pass sat reverted under six agents. An hour of hand reconciliation. |
| 3:30 to 4:00 | macOS QA of the pushed commit; fix pass 3, 15 agents, 7 findings | Found that the description normalizer ran after lint (so the headline fix from pass 1 never reached `add`), plus zsh PATH, a YAML key bug, base URL, rowsPath. Reviewers again flagged second call sites. |
| 4:00 to 4:40 | Fix pass 4 started and stopped by Wes; main loop fixes the leftovers by hand, 12 edits | Suite green, macOS verified, 0.3.1 published, site deployed. |

Subagent spend: about 5.5M tokens across the four workflows and three QA agents. The hand fixes at the end took 40 minutes.

## Why four rounds

1. **The fix-findings workflow assigned ownership by file.** Each implementer could edit exactly one file. The reviewer's standing question was "is this fixed at the root or at one call site?" Half the defects lived in two places: two flag parsers (`bin/declick.mjs` and `bin/run.mjs`), two did-you-mean functions, three copies of the rowsPath rule, two YAML key scanners, and a normalizer wired into `saveManifest` while lint ran earlier in `build`. Under file ownership those are unfixable in one pass by construction: the implementer fixes their file, the reviewer names the twin in another file, the workflow ends, and the next pass is needed. The workflow guaranteed N rounds for an N-site defect.
2. **The main loop dispatched from QA reports instead of reading the code first.** The reports were excellent. But a finding that says "line 130 throws before the envelope" needed one grep to discover the second parser. I wrote the finding, not the grep.
3. **The REVERT-TO-RED dispatch block asked for a red run without saying how to get one.** Agents reached for `git stash` on a tree six others were editing. Nothing forbade it in the workflow prompts and no hook backstopped it.
4. **The verify stage had no timeout discipline.** A failed assertion left an http server open, `npm test` hung, the verify agent burned its budget, and the workflow's final answer was "timed out" instead of a count.
5. **The delegate-first guard fought the fastest route.** When hands-on fixing was the right call, the guard capped direct edits at 8 per prompt and denied read-only verification pipelines whose log path was a shell variable. Every denial cost a retry with an override marker. The guard's economics (a subagent costs 60k tokens before its first tool call) were right for small tasks and wrong here: three delegated passes cost 3.7M tokens and two hours; the hand pass cost 40 minutes.
6. **Stale scratchpad launchers on PATH** made the suite report 33 false failures twice, each time costing a diagnosis.
7. **The advisor cap** blocked a QA agent's fourth consultation mid-investigation.

## What changed

- `hooks/git-tree-guard.cjs`: stash, path checkouts, restore, hard reset and clean are denied in shell calls; baselines come from copies. 18-case self-test.
- `workflows/fix-findings.js`: a finding may own several files (`files: [...]`); every fixer is told to grep for a second implementation of the same behaviour before editing and to list every site; groups a reviewer flags get one more fix round in the same run with the reviewer's problems as the brief and the reviewer's named files added to ownership; the verify agent runs the command under a timeout and reports a hang as a failure with the last test name. The shared-working-tree block is injected into every prompt.
- `fable-delegate-guard.cjs`: direct-edit budget 8 to 20 per prompt and 80 to 160 lines; a redirect to a shell variable is treated as scratch when the command names the scratchpad path; and a hands-on switch: a user prompt containing "hands-on" (or "do it yourself" / "line by line") suspends the guard for the rest of the session, "delegate again" restores it. Wes saying it once is the override, not a marker on every command.
- `capability-graph-guard.cjs`: advisor consultations counted, never capped.
- `dispatch-blocks` REVERT-TO-RED names the copy mechanism.
- declick: `scripts/qa-real-specs.sh` runs the six public specs, the real calls, the auth path, the PATH install and the Node guard from either a clone or the npm package, so the next release is judged by the same script on Linux and macOS before a tag; the test script runs with `--test-force-exit` so an open handle can no longer hang CI or a verify stage.

## The rule that comes out of it

A defect report names one site. Before dispatching a fix, grep for the second implementation of the same behaviour and put every site in one finding with one owner. A fix "at the root" is a property of the code base, not of the file the reporter happened to be looking at.
