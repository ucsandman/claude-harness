# Daily harness parity sync.
# Runs after NightlyMeditation (06:40), which is what promotes new rules into
# CLAUDE.md — so the generated AGENTS.md / GEMINI.md pick them up the same morning
# instead of drifting for three months the way the hand-written versions did.
#
# Registered as Task Scheduler job "HarnessParitySync". Remove with:
#   Unregister-ScheduledTask -TaskName HarnessParitySync -Confirm:$false

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:USERPROFILE '.claude\logs\harness-sync.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Add-Content -Path $log }

Log '--- harness parity sync start ---'

# Regenerate the rules files and re-link the shared skills.
$sync = & node (Join-Path $env:USERPROFILE '.claude\tools\harness-sync\sync.cjs') 2>&1
$sync | ForEach-Object { Log $_ }

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
  # bash eats Windows backslashes, so hand it an MSYS-style path. Passing
  # 'C:\Users\...' made bash report "No such file or directory" while the task
  # still exited 0 — the self-check silently never ran on the first attempt.
  $sh = ($env:USERPROFILE -replace '^([A-Za-z]):', '/$1' -replace '\\', '/').ToLower().Substring(0,2) +
        (($env:USERPROFILE -replace '^[A-Za-z]:', '' -replace '\\', '/')) +
        '/.claude/hooks/adapters/test-agy-adapter.sh'
  $test = & $bash $sh 2>&1
  $test | ForEach-Object { Log $_ }
  # Assert the positive result. "did not say FAILED" is not the same as "passed":
  # a script that never ran says neither.
  if (-not ($test -match 'all checks passed')) {
    Log 'ALERT: guard self-check did not report success - the shared guards may not be firing'
  }
} else {
  Log 'ALERT: guard self-check skipped, Git Bash not found'
}

# Refresh the human-facing status page.
$parity = & node (Join-Path $env:USERPROFILE '.claude\tools\harness-sync\parity.cjs') 2>&1
$parity | ForEach-Object { Log $_ }

Log '--- harness parity sync end ---'
