# Registers the harness background jobs in Windows Task Scheduler.
#
# Only the jobs whose scripts actually ship in this repo are listed here. My own
# machine runs more of them, but those call product repos you do not have.
#
# Prints the plan and changes nothing unless you pass -Execute.
#
#   pwsh -File scripts/install-scheduled-tasks.ps1
#   pwsh -File scripts/install-scheduled-tasks.ps1 -Execute
#
# Every job writes to its own out/ log next to its script. Read the log before
# you trust a job: a scheduled task that fails silently is worse than no task.

param(
  [string]$HarnessRoot = (Join-Path $HOME '.claude'),
  [string]$BashExe     = 'C:\Program Files\Git\bin\bash.exe',
  [string]$NodeExe     = 'C:\Program Files\nodejs\node.exe',
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $HarnessRoot)) { throw "HarnessRoot not found: $HarnessRoot" }

# Each job: task name, what it runs, and the trigger.
# Times are deliberate. The error log harvest runs BEFORE the meditation so the
# meditation reads a fresh log, and cronwatch runs before the briefing so the
# briefing can report a dead job.
$jobs = @(
  @{ Name = 'ClaudeErrorLog'
     Desc = 'Harvest yesterday errors and corrections from the transcripts'
     Exe  = $BashExe
     Args = "`"$HarnessRoot\scripts\errorlog\harvest.sh`""
     Trig = { New-ScheduledTaskTrigger -Daily -At '6:22am' } },

  @{ Name = 'NightlyMeditation'
     Desc = 'Reflection pass: append entries, promote rules, build one artifact'
     Exe  = $BashExe
     Args = "`"$HarnessRoot\scripts\meditation\run-nightly.sh`""
     Trig = { New-ScheduledTaskTrigger -Daily -At '6:40am' } },

  @{ Name = 'CronwatchDaily'
     Desc = 'Check every scheduled job is still firing'
     Exe  = $NodeExe
     Args = "`"$HarnessRoot\tools\cronwatch\cronwatch.cjs`" --all"
     Trig = { New-ScheduledTaskTrigger -Daily -At '6:50am' } },

  @{ Name = 'FleetBriefing'
     Desc = 'Morning briefing: what ran, what broke, what is stale'
     Exe  = $BashExe
     Args = "`"$HarnessRoot\scripts\fleet-briefing\run-daily.sh`""
     Trig = { New-ScheduledTaskTrigger -Daily -At '6:57am' } },

  @{ Name = 'HarnessAudit'
     Desc = 'Weekly audit of the harness itself'
     Exe  = $BashExe
     Args = "`"$HarnessRoot\scripts\harness-audit\run-weekly.sh`""
     Trig = { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '5:07am' } },

  @{ Name = 'HarnessHealthMonthly'
     Desc = 'Hook wiring and plugin health check'
     Exe  = 'pwsh'
     Args = "-NoProfile -File `"$HarnessRoot\scripts\harness-health.ps1`""
     Trig = { New-ScheduledTaskTrigger -Once -At '9:00am' -RepetitionInterval (New-TimeSpan -Days 30) } },

  @{ Name = 'DeploySentinel'
     Desc = 'Poll deployments every 30 minutes'
     Exe  = 'wscript.exe'
     Args = "`"$HarnessRoot\scripts\deploy-sentinel\run-sentinel-hidden.vbs`""
     Trig = { New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(6) -RepetitionInterval (New-TimeSpan -Minutes 30) } },

  @{ Name = 'ClaudeLspReaper'
     Desc = 'Reap orphaned language-server processes every 5 minutes'
     Exe  = 'wscript.exe'
     Args = "`"$HarnessRoot\hooks\lsp-reaper-launcher.vbs`""
     Trig = { New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(6) -RepetitionInterval (New-TimeSpan -Minutes 5) } }
)

$missing = @()
foreach ($j in $jobs) {
  # The quoted path is the first thing in Args for every job except the pwsh one.
  $target = ([regex]::Match($j.Args, '"([^"]+)"')).Groups[1].Value
  if ($target -and -not (Test-Path $target)) { $missing += "$($j.Name) -> $target" }
}

Write-Host ''
Write-Host "Harness root : $HarnessRoot"
Write-Host "Mode         : $(if ($Execute) { 'EXECUTE' } else { 'plan only (pass -Execute to register)' })"
Write-Host ''

foreach ($j in $jobs) {
  Write-Host ("{0,-22} {1}" -f $j.Name, $j.Desc)
}

if ($missing.Count) {
  Write-Host ''
  Write-Host 'Missing script targets (these jobs will be skipped):' -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if (-not $Execute) {
  Write-Host ''
  Write-Host 'Nothing registered. Re-run with -Execute.'
  return
}

foreach ($j in $jobs) {
  $target = ([regex]::Match($j.Args, '"([^"]+)"')).Groups[1].Value
  if ($target -and -not (Test-Path $target)) { continue }

  $action  = New-ScheduledTaskAction -Execute $j.Exe -Argument $j.Args
  $trigger = & $j.Trig
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
               -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

  Register-ScheduledTask -TaskName $j.Name -Action $action -Trigger $trigger `
    -Settings $set -Description $j.Desc -Force | Out-Null

  Write-Host "registered $($j.Name)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Done. Verify with:  Get-ScheduledTask | Where-Object TaskPath -notlike ''\Microsoft\*'''
Write-Host 'Then let one fire and READ its out/ log. A green task list is not evidence it worked.'
