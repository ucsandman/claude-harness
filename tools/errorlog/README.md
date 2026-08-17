# errorlog

Two daily error logs — one that harvests itself, one you type into.

The habit (Fable 5, 2026-08-16): *spend ten minutes every day writing down what
you got wrong. Not feelings, not gratitude. What did I predict that didn't
happen? What did I believe yesterday that turned out to be off? Where did I
waste effort because my assumption was wrong?*

**The design decision both halves are built on:** yesterday's belief has to be
on record *before* you score it. A "what did I get wrong" box on its own gets
answered from hindsight, and hindsight always makes you look reasonable. So
each side captures a prediction and scores it later against what actually
happened. The scoring half is the part that can't be fooled.

## `daily.cjs` — Wes's log (9:15pm)

Opens a page. Three steps, one screen:

1. **Score** the predictions you wrote yesterday — Happened / Partly / Nope,
   with a "what was actually true?" box that appears only when you missed.
2. **What did you get wrong today?** — the three questions above, verbatim.
3. **What do you expect tomorrow?** — 1-3 predictions. Tomorrow scores these.

Nothing is required. "Nothing today" is a real button. Ctrl+Enter saves. A
one-sentence day beats a skipped day.

```
node daily.cjs              # serve + open browser
node daily.cjs --no-open    # serve only
node daily.cjs --selftest   # 13 checks, no browser
ERRORLOG_PORT=7999 node daily.cjs
```

Serves on `127.0.0.1:7841`, shuts down after you save, and exits on its own
after 30 minutes idle. Nothing listens in the background. If the port is busy
it probes for its own page first and refuses to hijack someone else's app.

Data: `~/.claude/error-log/wes.jsonl`, append-only, newest record per date
wins.

## `errorlog.cjs` — Claude's log (6:22am)

I already write this log every day and throw it away. CLAUDE.md makes me emit
an `ASSUMPTIONS I'M MAKING` block before non-trivial work and a `DEVIATIONS
FROM PLAN` block in every summary. Measured on 2026-08-16: **481 real
deviations across 8 days**, reading like *"I expected the vault to define
STRIPE_LIVE_SECRET_KEY. It did not."* That is a prediction error log. It was
evaporating into transcript files nobody reads.

This harvests it out of `~/.claude/projects/**/*.jsonl`, merges the
`corrections.jsonl` entries where Wes corrected me, and renders the one thing
a pile of mistakes is actually for: what I get wrong **repeatedly**.

```
node errorlog.cjs             # yesterday, append + render
node errorlog.cjs --days 7
node errorlog.cjs --rebuild   # 30 days
node errorlog.cjs --open
node errorlog.cjs --selftest  # 17 checks
```

Output: `errorlog.html` (generated). Data: `~/.claude/error-log/claude.jsonl`,
append-only, deduped by normalized content hash so re-running is safe.

No LLM in the loop — it is a deterministic parse. That means the nightly run
costs nothing and **cannot die on a usage limit**, which is exactly what killed
`NightlyMeditation` on 2026-08-16 (Sunday → fable → "You've reached your Fable
5 limit", zero artifacts for the week's most important night).

### Two traps this had to be built around

**A plain `grep -l` over the transcripts is a false positive.** CLAUDE.md is
echoed into every transcript and contains the literal strings `DEVIATIONS FROM
PLAN` and `ASSUMPTIONS`. The first measurement said 227 files and every one of
them was the instruction text. Only an *assistant-authored* text block counts.

**Not every deviation is an error.** Real blocks also carry scope growth
("auto-cancel was not in the original scope"), explicit "the plan held" notes,
and `VERIFICATION` bullets that leak past a title-case or bold heading. Those
are filtered out, or the genuine mistakes get buried.

### On the buckets

Keyword buckets classify about a third of the entries and the rest stay
`unclassified` rather than being forced into a label. That is deliberate:
regex cannot read free prose, and a fake label is worse than none. `unclassified`
is excluded from the repeat-pattern list, because "unclassified recurred 8 days
running" is the classifier shrugging, not a finding.

Finding the real repeated pattern is the **nightly meditation's** job — it reads
`claude.jsonl` during its grounding step (`skills/meditate/SKILL.md`, step 1) and
a pattern it names on 3+ separate days becomes a `CANDIDATES.md` sighting. That
is what keeps this a feedback loop instead of a museum.

## Scheduling

Windows Task Scheduler, registered and verified 2026-08-16:

| Task | When | Runs |
|---|---|---|
| `ClaudeErrorLog` | 6:22am daily | `scripts/errorlog/harvest.sh` — before `NightlyMeditation` at 6:40am, so the meditation reads a fresh log |
| `WesErrorLog` | 9:15pm daily | `scripts/errorlog/daily-launcher.vbs` — hidden node, visible browser |

Both are on the health board: `node ~/.claude/tools/cronwatch/cronwatch.cjs`.
Logs in `~/.claude/scripts/errorlog/out/`.

To move the evening time, change the trigger — no code change:

```powershell
Set-ScheduledTask -TaskName WesErrorLog -Trigger (New-ScheduledTaskTrigger -Daily -At '10:30PM')
```

## Files

- `daily.cjs` — Wes's nightly page (zero deps, local server)
- `errorlog.cjs` — Claude's harvester (zero deps, static HTML out)
- `errorlog.html` — generated, gitignored
