# Daily harness parity sync.
# Runs after NightlyMeditation (06:40), which is what promotes new rules into
# CLAUDE.md, so every other client picks them up the same morning instead of
# drifting for three months the way the hand-written versions did.
#
# Since 2026-09-06 the port is done by the Agnostic-AI repo
# (C:\Projects\agnostic-ai, `npm run port`): it captures ~/.claude and applies
# rules, hooks, skills, agents, commands, MCP servers and permissions to every
# installed client (Codex, Gemini CLI, Antigravity, Cursor and the rest). The
# old tools\harness-sync\sync.cjs is retired (sync.cjs.retired-20260906).
#
# Registered as Task Scheduler job "HarnessParitySync". Remove with:
#   Unregister-ScheduledTask -TaskName HarnessParitySync -Confirm:$false

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE '.claude\logs\harness-sync.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Add-Content -Path $log }

Log '--- harness parity sync start ---'

# Capture the Claude harness and apply it to every other installed client.
$port = & node 'C:\Projects\agnostic-ai\engine\harness\cli.cjs' port 2>&1
$port | ForEach-Object { Log $_ }
if ($LASTEXITCODE -ne 0) { Log "ALERT: port exited $LASTEXITCODE" }

# Prove the shared guards still block AND still pass. A guard that stopped firing
# is invisible otherwise (rule L1).
# Must be Git Bash, explicitly. `Get-Command bash` resolves to WSL's
# C:\Windows\system32\bash.exe, which has no /c/Users mount and fails the script
# with "No such file or directory".
$bash = @(
  'C:\Program Files\Git\bin\bash.exe',
  'C:\Program Files\Git\usr\bin\bash.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($bash) {
  # bash eats Windows backslashes, so hand it an MSYS-style path.
  $sh = ($env:USERPROFILE -replace '^([A-Za-z]):', '/$1' -replace '\\', '/').ToLower().Substring(0,2) +
        (($env:USERPROFILE -replace '^[A-Za-z]:', '' -replace '\\', '/')) +
        '/.claude/hooks/adapters/test-agy-adapter.sh'
  $test = & $bash $sh 2>&1
  $test | ForEach-Object { Log $_ }
  # Assert the positive result. "did not say FAILED" is not the same as "passed".
  if (-not ($test -match 'all checks passed')) {
    Log 'ALERT: guard self-check did not report success - the shared guards may not be firing'
  }
} else {
  Log 'ALERT: guard self-check skipped, Git Bash not found'
}

# Refresh the human-facing status page (per-client, per-component matrix).
$status = & node 'C:\Projects\agnostic-ai\engine\harness\cli.cjs' status --html 2>&1
$status | ForEach-Object { Log $_ }

Log '--- harness parity sync end ---'
