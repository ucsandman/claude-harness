# cronwatch

Health board for Windows Task Scheduler jobs. Task Scheduler jobs
(`FleetBriefing7am` at 6:57am, `NightlyMeditation` at 6:40am, and others)
fail silently — nothing pages you, nothing shows red. A failed overnight
job should be a red row on a page, not a mystery discovered days later.
`cronwatch` scans the local Task Scheduler and renders that surface.

## Usage

```
node cronwatch.cjs                    # default filter, terminal + cronwatch.html
node cronwatch.cjs --all              # every scheduled task, no filter
node cronwatch.cjs --filter <regex>   # custom filter (case-insensitive), overrides default and --all
node cronwatch.cjs --open             # also open cronwatch.html in the default browser
```

Output: `cronwatch.html` in this directory (generated — do not hand-edit,
see `.gitignore`).

Exit code: `1` when the board has a FAILED row that is yours, so the
`CronwatchDaily` task's own Last Result is a verdict (the Opening Move
reads it: "board lists failed tasks"). Two kinds of FAILED row render but
do not count: Windows' own housekeeping under `\Microsoft\` (nobody fixes
"Windows Defender Scheduled Scan: file not found"), and this board itself
(its last result is 1 whenever yesterday's board was red). STALE rows
never count. `1` also if the Task Scheduler query itself fails
(PowerShell not found, the query errors, or its JSON can't be parsed);
that failure prints the real stderr, never an empty board pretending
health. Stderr always carries the count: `N of M scheduled task(s) FAILED`.

Probe: `node tools/cronwatch/tests/cronwatch-probe.cjs` (fixtures, no
Task Scheduler).

## Default filter

By default only tasks whose name, path, or action (execute + arguments)
text matches `/claude|fleet|meditat|briefing/i` are shown. `--all` shows
every task on the machine (~228 on this machine, most unrelated to
Claude). `--filter <regex>` replaces the default filter entirely.

## Data source

One PowerShell invocation (`pwsh` if on PATH, else `powershell`), run
once, that pipes `Get-ScheduledTask` through `Get-ScheduledTaskInfo` per
task and emits JSON: task name, path, state, `LastRunTime`,
`LastTaskResult`, `NextRunTime`, and the action's `Execute` +
`Arguments`. Node parses that JSON — the task list is never re-queried
per task from Node, and no task is ever registered, modified, run, or
deleted.

**PowerShell JSON date quirk** (confirmed against real output on this
machine before writing the parser, not assumed): `pwsh` (PowerShell 7)
serializes `DateTime` as an ISO string (`"2026-08-13T06:57:01-04:00"`).
Windows PowerShell 5.1 (`powershell.exe`) serializes the same value as
`"/Date(1786652732129)/"` (a `.NET` `JavaScriptSerializer` tick-count
wrapper). `cronwatch.cjs` handles both.

**"Never run" sentinel**: a task that has never fired reports
`LastRunTime` as `1999-11-30T00:00:00` (Task Scheduler's placeholder
epoch) and `LastTaskResult` `267011` (`0x41303`). `cronwatch` detects any
`LastRunTime` year before 2001 and displays `never run` instead of the
sentinel date.

## Health classification

- **OK** — `LastTaskResult` is `0`, or `0x41300` (ready, waiting for its
  next run — scheduler status, not a failure).
- **RUNNING** — `0x41301` (decimal 267009), or task `State` is `Running`:
  the task is mid-run at query time. Blue badge, not red: querying during a
  run is not a failure. The `State` check also covers a daemon registered
  with "do not start a new instance" whose keepalive trigger reports
  `0x800710E0` (request refused) while the old instance is still running.
- **NEVER-RUN** — `0x41303`, the task has never fired. Neutral gray: a
  freshly registered task is not broken.
- **FAILED** — any other nonzero `LastTaskResult`, decoded where the code
  is recognized (`0x1` generic failure, `0x41306` terminated by user, and
  a handful of others), otherwise shown as `error 0x<hex>`.
- **STALE** — enabled, `LastTaskResult` is `0`, and `LastRunTime` is more
  than 2x the task's own cadence in the past. Cadence is derived as
  `NextRunTime - LastRunTime` from the same query (no trigger/schedule
  XML parsing) — if either timestamp is missing or the derived cadence
  isn't a positive interval, staleness is skipped rather than guessed.
- **DISABLED** — task `State` is `Disabled` (checked before the above,
  regardless of its last result).

Terminal output is one line per task plus a summary line. `cronwatch.html`
renders the same set as a table, red rows for FAILED, amber for STALE,
gray for DISABLED and NEVER-RUN, sorted problems-first (FAILED, STALE,
NEVER-RUN, DISABLED, RUNNING, OK, then alphabetical within each group).

## Files

- `cronwatch.cjs` — the generator (zero dependencies, Node only)
- `cronwatch.html` — generated output (gitignored)
- `README.md` — this file
