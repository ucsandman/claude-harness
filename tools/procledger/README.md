# procledger

A process ledger for Claude Code. Every process an agent starts gets a PID
recorded alongside its exact start time, so cleanup is always PID-based and
safe.

## Why

`process-kill-guard.cjs` blocks name-based process kills (`Stop-Process -Name`,
`taskkill /IM`, ...) because a subagent once ran `Stop-Process -Name notepad`
to clean up its own test window and killed the user's real Notepad session
instead, with ~40 unsaved tabs. The rule that came out of it was "capture the
PID when you start a process" — procledger makes that structural: `start`
records the PID and the process's own `StartTime`, and every later verb
refuses to act on a PID unless its live `StartTime` still matches what was
recorded, so a reused PID can never be mistaken for the process you launched.

## Usage

`procledger.ps1` is not on PATH. Invoke it by full path, or `cd` into this
directory first.

```powershell
pwsh -File ~/.claude/tools/procledger/procledger.ps1 start -Purpose "<why>" -- <command and args...>
pwsh -File ~/.claude/tools/procledger/procledger.ps1 list
pwsh -File ~/.claude/tools/procledger/procledger.ps1 stop <pid>
pwsh -File ~/.claude/tools/procledger/procledger.ps1 reap
pwsh -File ~/.claude/tools/procledger/procledger.ps1 prune
```

- **start** — launches `<command and args...>` via `Start-Process`, captures
  the `Process` object, appends one entry to `ledger.jsonl`, and prints the
  PID to stdout.
- **list** — prints a table of every ledger entry. For each entry still
  marked `running`, checks liveness right now (`Get-Process -Id` plus a
  `StartTime` match, ~2s tolerance) and rewrites it to `exited` in the ledger
  if the PID is gone or was reused.
- **stop `<pid>`** — refuses (exit 1) unless `<pid>` is a `running` entry in
  the ledger AND its live `StartTime` matches the recorded one. Otherwise
  stops it by PID and marks the entry `stopped`.
- **reap** — stops every ledger entry that is genuinely still running (same
  `StartTime` check per entry), reporting each result. Entries whose PID is
  gone or reused are marked `exited` instead of touched.
- **prune** — removes non-`running` entries older than 7 days from the
  ledger.

## Ledger format

`ledger.jsonl`, one JSON object per line, append-only except when a verb
updates statuses (in which case the whole file is rewritten):

```json
{"pid":12345,"processStartTime":"2026-08-13T10:15:23.1234567-07:00","command":"powershell -NoProfile -Command Start-Sleep 300","purpose":"self-test","session":null,"startedAt":"2026-08-13T10:15:23.1234567-07:00","status":"running"}
```

`status` is one of `running`, `stopped`, `exited`. `session` is
`$env:CLAUDE_SESSION_ID` when set, else `null`. `ledger.jsonl` is generated
state and is gitignored.

## Exit codes

| code | meaning |
|---|---|
| 1 | hard error — bad arguments, PID not in ledger, PID not `running`, or `StartTime` mismatch (refused to avoid killing a reused PID) |
| 0 | success |

## Dependencies

None. PowerShell 7 (`pwsh`) only.
