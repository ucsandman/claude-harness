---
name: prompt-dispatch
description: "UserPromptSubmit is one process (prompt-dispatch.cjs) running the prompt hooks in-process; wakeup-guard.cjs stops a session from answering every Monitor wake-up with Waiting."
context:
  triggers:
    keywords: ["prompt-dispatch", "wakeup-guard", "hook timed out", "UserPromptSubmit", "Waiting.", "task-notification", "Monitor wake-up"]
  priority: 40
---
# prompt-dispatch.cjs and wakeup-guard.cjs (2026-09-19)

UserPromptSubmit is ONE registered command, `prompt-dispatch.cjs`, timeout 30 s.
It reads the payload once and runs every prompt hook in-process (its `CHAIN`:
wakeup-guard, opening-move, scope-lock, opus-handoff-inject, correction-tracker,
repeat-tool-guard --reset, fable-delegate-guard, mods-liveness, context-graph),
intercepting fd 0, stdout and `process.exit` around each require, then merges
the answers: additionalContext joined in chain order, the first `decision: block`
wins, systemMessages concatenated. Per-hook ms go to
`~/.claude/state/prompt-dispatch.jsonl` (`--report` prints medians; `--list` the
chain). A hook that throws is skipped and logged, never fatal. Why: eight spawns
per prompt at 5 s each timed out on every prompt once a bare node start cost
2.6 s under load, and every machine wake-up repeated the set. Add a prompt hook
by adding it to `CHAIN`, never as a second settings.json entry: the doctor's
`prompt-hooks` check fails on more than one command or a timeout under 20 s,
and `first-run.cjs` installs the dispatcher, not the individual guards.
`context-nudge` (the 80 % context reminder) was removed on 2026-09-26.

`wakeup-guard.cjs` counts consecutive machine wake-ups per session (a prompt
starting with `<task-notification>`, or any `source` outside user/sdk; a human
prompt resets the streak, state in `~/.claude/state/wakeups/`). From the third
one it injects: no "Waiting." text, end the turn silently if nothing changed,
TaskStop the Monitor and the stalled task if nothing progressed, re-arm only at
>= 1200 s. Why: a Monitor on "screenshots landing" fired once per PNG, 17
wake-ups in 45 min, each answered "Waiting.", 1.4M tokens on a workflow at 0 of
12. No override marker: it only speaks, it never blocks. `context-graph.cjs`
also skips `<task-notification>` prompts now. Probe:
`engine/hooks/tests/prompt-dispatch-probe.cjs`.

`opening-move.cjs` (2026-11-09, second in the chain, `exportedMain`) is the
prompt half of the Opening Move brief; its SessionStart half is the same file,
registered on `startup|clear|compact`. On a human prompt from a `cli` session
it writes one ring row per session to
`~/.claude/state/opening-move/repos/<key>.json` (newest first, at most 5; a
sibling row under 10 minutes old is what the brief calls LIVE SIBLING), then
binds "go": on the session's first prompt, a WHOLE prompt of go, go ahead,
continue, next, resume, do it, yes, ok, start, what's next, hi, hey or morning
injects the NEXT the brief showed, once. A `me` NEXT is started, a `you` NEXT
(any hard stop) is only prepared; "thoughts?" or "go through the logs" never
bind. A stored Next line is injected at most 160 characters long, with its
double quotes turned into `'` and a closing clause saying it is the last
session's line, not Wes's words. Machine turns, other entrypoints and
`OPENING_MOVE=off` return nothing. Probe:
`engine/hooks/tests/opening-move-probe.cjs` (`--stub` must fail every case,
`--leaky` must fail every negative).

