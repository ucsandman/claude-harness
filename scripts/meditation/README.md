# Meditation runner

Nightly reflection loop (see `docs/superpowers/specs/2026-08-11-nightly-meditation-design.md`).

- `run-nightly.sh` — invoked by Task Scheduler task **NightlyMeditation** at
  6:40am daily. Opus + xhigh weekdays; Fable + xhigh Sundays (weekly synthesis).
  It runs just before the 7am fleet briefing, so the night's takeaway is fresh
  when the email goes out.
- The loop itself is the `/meditate` skill (`skills/meditate/SKILL.md`).
- Output: `~/.claude/meditations/` (reflections, digests) — the digest is at
  `meditations/digests/latest.html`; the 7am briefing email carries the
  one-line takeaway.
- Logs: `out/run.log` (gitignored).
- Manual run: `/meditate` in any session, or `bash run-nightly.sh`.
- Dry run: `MEDITATE_DRYRUN=1 bash run-nightly.sh`.
- Exit code: the runner checks its own artifacts (today's digest + a
  `latest-line.txt` under 24h old) and exits **1** with
  `MEDITATION FAILED: no artifacts` if they are missing. The headless session
  returns 0 even when it writes nothing, so its exit code alone proves nothing.
  It is still not ignored: if the artifacts exist but the session exited
  nonzero, the runner logs `MEDITATION FAILED: session rc=<n>` and exits with
  that same code, so Task Scheduler sees a failure either way.

## Why the session runs with `bypassPermissions`

Claude Code has a built-in sensitive-file gate covering everything under
`~/.claude/`, and in a headless session it blocks every write the meditation
loop needs — the first live run produced zero artifacts because of it. The
narrower fixes were each tested against a real session and all failed:
`--permission-mode acceptEdits`, an `allowedTools` `Write(...)` rule, and an
explicit `Edit(~/.claude/meditations/**)` allow rule were all denied. Only
`bypassPermissions` lifts the gate, so Wes chose it on 2026-08-11 knowing the
tradeoff.

Because the permission prompt is gone, the blast radius is bounded by removing
capability instead (tightened after the 2026-08-11 security review). The session
gets **no MCP servers** — `--strict-mcp-config` with no `--mcp-config` means the
global `offlocal`/`sidetap`/`xapi`/`dashclaw-local` servers never load, so the
email, SMS, phone, and deploy tools do not exist for it to call. It gets **no
machine credentials in Bash** — the runner exports
`CLAUDE_HEADLESS_MEDITATION=1` and `~/.claude/load-secrets.sh` returns early on
that marker, so no Stripe/Neon/Clerk/Resend key is in any Bash environment. It
gets **no Anthropic API key** (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are
unset, so the run bills the subscription). On top of that the prompt is a fixed
skill whose own hard rules forbid external actions and require staging by
explicit pathspec, and PreToolUse hooks still fire. The alternative — moving
`meditations/` outside `.claude/`
into its own repo — was the other real option and remains the cleaner long-term
answer if this ever needs revisiting.
