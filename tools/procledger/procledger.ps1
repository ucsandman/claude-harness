#Requires -Version 7
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$ledgerPath = Join-Path $root 'ledger.jsonl'

$verb = if ($args.Count -gt 0) { $args[0] } else { 'help' }
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })

function Read-Ledger {
  if (-not (Test-Path -LiteralPath $ledgerPath)) { return @() }
  $lines = @(Get-Content -LiteralPath $ledgerPath | Where-Object { $_.Trim().Length -gt 0 })
  return @($lines | ForEach-Object { $_ | ConvertFrom-Json })
}

function Write-Ledger($entries) {
  $lines = @($entries | ForEach-Object { $_ | ConvertTo-Json -Compress })
  Set-Content -LiteralPath $ledgerPath -Value $lines -Encoding UTF8
}

function Add-LedgerEntry($entry) {
  $line = $entry | ConvertTo-Json -Compress
  Add-Content -LiteralPath $ledgerPath -Value $line -Encoding UTF8
}

# ConvertFrom-Json coerces ISO-8601-looking strings to [datetime] on its own, but
# guard both shapes explicitly rather than assume that behavior holds everywhere.
function Get-AsDateTime($val) {
  if ($val -is [datetime]) { return $val }
  return [datetime]::Parse([string]$val, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
}

# Core correctness rule: a PID is only ever treated as "ours" when a live process
# at that PID exists AND its StartTime matches the ledger within ~2s. A PID whose
# StartTime doesn't match was reused by an unrelated process — never touch it.
function Test-StillRunning($entry) {
  $proc = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $recorded = Get-AsDateTime $entry.processStartTime
  $diff = [math]::Abs(($proc.StartTime - $recorded).TotalSeconds)
  return $diff -le 2
}

switch ($verb) {
  'start' {
    $purpose = $null
    $i = 0
    while ($i -lt $rest.Count -and $rest[$i] -ne '--') {
      if ($rest[$i] -eq '-Purpose') { $purpose = $rest[$i + 1]; $i += 2; continue }
      $i++
    }
    if ($i -lt $rest.Count -and $rest[$i] -eq '--') { $i++ }
    $cmdArgs = @(if ($i -lt $rest.Count) { $rest[$i..($rest.Count - 1)] } else { @() })

    if (-not $purpose) {
      Write-Error 'start requires -Purpose "<why>"' -ErrorAction Continue
      exit 1
    }
    if ($cmdArgs.Count -eq 0) {
      Write-Error 'start requires a command after --' -ErrorAction Continue
      exit 1
    }

    $exe = $cmdArgs[0]
    $exeArgs = @(if ($cmdArgs.Count -gt 1) { $cmdArgs[1..($cmdArgs.Count - 1)] } else { @() })

    $proc = Start-Process -FilePath $exe -ArgumentList $exeArgs -PassThru
    Start-Sleep -Milliseconds 150
    $proc.Refresh()

    $entry = [ordered]@{
      pid               = $proc.Id
      processStartTime  = $proc.StartTime.ToString('o')
      command           = ($cmdArgs -join ' ')
      purpose           = $purpose
      session           = if ($env:CLAUDE_SESSION_ID) { $env:CLAUDE_SESSION_ID } else { $null }
      startedAt         = (Get-Date).ToString('o')
      status            = 'running'
    }
    Add-LedgerEntry $entry
    Write-Host $proc.Id
    exit 0
  }

  'list' {
    $entries = Read-Ledger
    $changed = $false
    foreach ($e in $entries) {
      if ($e.status -eq 'running' -and -not (Test-StillRunning $e)) {
        $e.status = 'exited'
        $changed = $true
      }
    }
    if ($changed) { Write-Ledger $entries }

    if ($entries.Count -eq 0) {
      Write-Host '(ledger is empty)'
      exit 0
    }

    "{0,-8} {1,-9} {2,-20} {3,-24} {4}" -f 'PID', 'STATUS', 'STARTED', 'PURPOSE', 'COMMAND' | Write-Host
    foreach ($e in $entries) {
      $started = (Get-AsDateTime $e.startedAt).ToString('yyyy-MM-dd HH:mm:ss')
      "{0,-8} {1,-9} {2,-20} {3,-24} {4}" -f $e.pid, $e.status, $started, $e.purpose, $e.command | Write-Host
    }
    exit 0
  }

  'stop' {
    if ($rest.Count -eq 0) {
      Write-Error 'stop requires a pid' -ErrorAction Continue
      exit 1
    }
    $targetPid = [int]$rest[0]
    $entries = Read-Ledger
    $entry = $entries | Where-Object { [int]$_.pid -eq $targetPid } | Select-Object -Last 1

    if (-not $entry) {
      Write-Error "pid $targetPid is not in the ledger" -ErrorAction Continue
      exit 1
    }
    if ($entry.status -ne 'running') {
      Write-Error "pid $targetPid is not running in the ledger (status: $($entry.status))" -ErrorAction Continue
      exit 1
    }
    if (-not (Test-StillRunning $entry)) {
      $entry.status = 'exited'
      Write-Ledger $entries
      Write-Error "pid $targetPid does not match the recorded start time (likely PID reuse); refusing to stop it. Marked exited in the ledger." -ErrorAction Continue
      exit 1
    }

    Stop-Process -Id $targetPid -Confirm:$false
    $entry.status = 'stopped'
    Write-Ledger $entries
    Write-Host "stopped pid $targetPid"
    exit 0
  }

  'reap' {
    $entries = Read-Ledger
    $any = $false
    foreach ($e in $entries) {
      if ($e.status -ne 'running') { continue }
      $any = $true
      if (Test-StillRunning $e) {
        try {
          Stop-Process -Id ([int]$e.pid) -Confirm:$false -ErrorAction Stop
          $e.status = 'stopped'
          Write-Host "stopped pid $($e.pid) ($($e.purpose))"
        } catch {
          Write-Host "failed to stop pid $($e.pid): $($_.Exception.Message)"
        }
      } else {
        $e.status = 'exited'
        Write-Host "pid $($e.pid) already exited or start time mismatch; marked exited"
      }
    }
    if (-not $any) { Write-Host '(nothing to reap)' }
    Write-Ledger $entries
    exit 0
  }

  'prune' {
    $entries = Read-Ledger
    $cutoff = (Get-Date).AddDays(-7)
    $kept = @($entries | Where-Object {
      if ($_.status -eq 'running') { return $true }
      return (Get-AsDateTime $_.startedAt) -ge $cutoff
    })
    $removed = $entries.Count - $kept.Count
    Write-Ledger $kept
    Write-Host "pruned $removed entr$(if ($removed -eq 1) { 'y' } else { 'ies' })"
    exit 0
  }

  default {
    Write-Host 'procledger - PID-safe process ledger'
    Write-Host '  procledger start -Purpose "<why>" -- <command...>   launch and record'
    Write-Host '  procledger list                                     show ledger, refresh liveness'
    Write-Host '  procledger stop <pid>                                stop a ledger-tracked pid'
    Write-Host '  procledger reap                                      stop everything still running'
    Write-Host '  procledger prune                                     drop old non-running entries'
    exit 0
  }
}
