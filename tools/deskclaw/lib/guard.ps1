Set-StrictMode -Version Latest

function Get-DeskRoot {
  return (Split-Path $PSScriptRoot -Parent)
}

function Test-DeskStop {
  param([string]$Root)
  return (Test-Path -LiteralPath (Join-Path $Root 'state\STOP'))
}

# Stage 2 arm switch. Lives here with Test-DeskStop so anything that sources the
# gating lib (viewer, tests, act) sees it. Two ways to arm (decision 2026-08-13,
# Wes explicitly traded the viewer-only gate for flow): the viewer buttons write
# a permanent ACT-ARMED; `desk arm [minutes]` writes one with an `expires=` line
# and defaults to 30 minutes. An expired or unparseable expiry counts as
# DISARMED — the switch fails closed, it never fails into acting.
function Test-DeskArmed {
  param([string]$Root)
  $path = Join-Path $Root 'state\ACT-ARMED'
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $expLine = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) |
    Where-Object { $_ -match '^expires=' } | Select-Object -First 1
  if (-not $expLine) { return $true }  # viewer-armed: no expiry
  try {
    $exp = [datetime]::Parse(($expLine -replace '^expires=', ''),
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AdjustToUniversal)
  } catch { return $false }
  return ((Get-Date).ToUniversalTime() -lt $exp)
}

function Write-DeskAudit {
  param([string]$Root, [string]$Verb, [string]$Target, [string]$Detail)
  $stateDir = Join-Path $Root 'state'
  if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  }
  $entry = [ordered]@{
    ts     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    verb   = $Verb
    target = $Target
    detail = $Detail
  }
  Add-Content -LiteralPath (Join-Path $stateDir 'audit.jsonl') `
    -Value ($entry | ConvertTo-Json -Compress)
}
