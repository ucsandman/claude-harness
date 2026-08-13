<#
.SYNOPSIS
  Detect and clear a wedged agent-browser daemon.

.DESCRIPTION
  agent-browser runs a background daemon and records it in
  ~/.agent-browser/<session>.pid and <session>.port. Its listening socket is
  INHERITED by the Chrome child processes. If the daemon dies without a clean
  shutdown (crash, taskkill, or killing its Chrome), the port stays LISTENING
  because a child still holds the handle, and netstat keeps crediting the dead
  PID.

  agent-browser's liveness check trusts the listening port. So it never starts a
  replacement daemon, and every command connects to a socket nobody is
  servicing. The connection reaches ESTABLISHED and then blocks on a read that
  never returns:

      x Could not configure browser: Failed to read: ... (os error 10060)

  That error reads like a remote network failure. It is pure loopback. Diagnosed
  2026-08-11; without this script the state survives until reboot.

  Gotcha worth knowing: piping agent-browser through `| tail` hides the message
  entirely, because tail waits for EOF and the daemon holds the pipe open. It
  looks like an infinite hang. Use `| head` or redirect to a file.

.PARAMETER Session
  Session name to inspect. Defaults to 'default'. Other sessions' *.config and
  *.engine files are never touched.

.PARAMETER Check
  Diagnose only. Changes nothing. Exit 0 = healthy, 1 = wedged.

.PARAMETER Force
  Run the cleanup even when the daemon looks healthy.

.EXAMPLE
  powershell -NoProfile -File ~/.claude/scripts/agent-browser-unwedge.ps1 -Check
  powershell -NoProfile -File ~/.claude/scripts/agent-browser-unwedge.ps1

.NOTES
  CLI-only is a deliberate decision here (CLAUDE.md section 5 requires that be
  recorded). The consumer is a terminal session that has just hit a 30s timeout
  mid-task; a button or page would be strictly slower to reach than the command
  already being typed. The human surface is the diagnostic output itself, which
  names the state, the evidence, and what changed.
#>
[CmdletBinding()]
param(
  [string]$Session = 'default',
  [switch]$Check,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$abRoot = Join-Path $env:USERPROFILE '.agent-browser'
$STATE_SUFFIXES = @('pid', 'port', 'target', 'stream', 'version', 'engine')

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Read-StateFile([string]$suffix) {
  $p = Join-Path $abRoot "$Session.$suffix"
  if (-not (Test-Path $p)) { return $null }
  $v = (Get-Content $p -Raw -ErrorAction SilentlyContinue)
  if ($null -eq $v) { return $null }
  return $v.Trim()
}

function Test-ProcessAlive([int]$procId) {
  if ($procId -le 0) { return $false }
  try { $null = Get-Process -Id $procId -ErrorAction Stop; return $true } catch { return $false }
}

# Returns the OwningProcess of a listener on $port, or $null when nothing listens.
# In the wedged state this returns the DEAD pid, which is the whole tell.
function Get-ListenerOwner([int]$port) {
  if ($port -le 0) { return $null }
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch {
    # Fall back to netstat on hosts without the NetTCPIP module.
    $line = (netstat -ano | Select-String -Pattern ":$port\s" | Select-String -Pattern 'LISTENING' | Select-Object -First 1)
    if ($line) { return [int](($line.ToString().Trim() -split '\s+')[-1]) }
  }
  return $null
}

# Only ever Chrome that agent-browser itself manages. Never a blanket chrome.exe
# kill: that would take out a real browser session.
function Get-AgentBrowserProcs {
  $procs = @()
  foreach ($name in @('chrome.exe', 'agent-browser-win32-x64.exe')) {
    try {
      $procs += Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction Stop |
        Where-Object {
          $_.ExecutablePath -and
          ($_.ExecutablePath.StartsWith($abRoot, [StringComparison]::OrdinalIgnoreCase) -or $name -eq 'agent-browser-win32-x64.exe')
        }
    } catch {}
  }
  return $procs
}

# ─── Diagnose ─────────────────────────────────────────────────────────────
if (-not (Test-Path $abRoot)) { Say "agent-browser is not installed ($abRoot missing)." 'Yellow'; exit 0 }

$pidRaw  = Read-StateFile 'pid'
$portRaw = Read-StateFile 'port'
$daemonPid  = 0; $daemonPort = 0
if ($pidRaw  -match '^\d+$') { $daemonPid  = [int]$pidRaw }
if ($portRaw -match '^\d+$') { $daemonPort = [int]$portRaw }

$alive    = Test-ProcessAlive $daemonPid
$owner    = Get-ListenerOwner $daemonPort
$listening = $null -ne $owner

if (-not $pidRaw -and -not $portRaw) { $state = 'CLEAN' }
elseif ($listening -and $alive)      { $state = 'HEALTHY' }
elseif ($listening -and -not $alive) { $state = 'WEDGED' }
else                                 { $state = 'STALE' }

Say ""
Say "agent-browser session '$Session'" 'Cyan'
Say "  recorded pid   : $(if ($pidRaw)  { $pidRaw }  else { '(none)' })  -> $(if ($alive) { 'ALIVE' } else { 'not running' })"
Say "  recorded port  : $(if ($portRaw) { $portRaw } else { '(none)' })  -> $(if ($listening) { "LISTENING (owner pid $owner)" } else { 'not listening' })"
$procs = @(Get-AgentBrowserProcs)
Say "  managed procs  : $($procs.Count) (agent-browser's own Chrome + daemon)"

switch ($state) {
  'CLEAN'   { Say "  STATE: CLEAN - no daemon recorded, nothing to fix." 'Green' }
  'HEALTHY' { Say "  STATE: HEALTHY - daemon alive and serving its port." 'Green' }
  'STALE'   { Say "  STATE: STALE - leftover state files, port already free. Harmless but tidy to clear." 'Yellow' }
  'WEDGED'  {
    Say "  STATE: WEDGED - port is LISTENING but its owner pid $owner does not exist." 'Red'
    Say "         An orphaned inherited socket is accepting connections that nothing services." 'Red'
    Say "         Every agent-browser command will fail after ~30s with os error 10060." 'Red'
  }
}
Say ""

if ($Check) {
  if ($state -eq 'WEDGED') { Say "Run without -Check to clear it." 'Yellow'; exit 1 }
  exit 0
}

if ($state -eq 'HEALTHY' -and -not $Force) { Say "Nothing to do. Use -Force to clear a healthy session anyway." 'Gray'; exit 0 }
if ($state -eq 'CLEAN') { exit 0 }

# ─── Fix ──────────────────────────────────────────────────────────────────
Say "Clearing..." 'Cyan'

# 1. Graceful shutdown first. Best effort, capped, since a wedged daemon may
#    never answer.
# Go through cmd.exe rather than resolving the shim ourselves. Get-Command
# resolves npm's extensionless sh shim, which Start-Process rejects with
# "%1 is not a valid Win32 application"; cmd.exe applies PATHEXT and picks the
# .cmd. Worth doing gracefully because a clean close lets agent-browser write
# its session-restore state, which a hard kill would lose.
try {
  $tOut = Join-Path $env:TEMP "ab-unwedge-$PID.out"
  $tErr = Join-Path $env:TEMP "ab-unwedge-$PID.err"
  $p = Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', 'agent-browser', 'close', '--all' `
        -NoNewWindow -PassThru -RedirectStandardOutput $tOut -RedirectStandardError $tErr -ErrorAction Stop
  if ($p.WaitForExit(8000)) { Say "  graceful 'close --all' succeeded" }
  else { $p.Kill(); Say "  graceful 'close --all' timed out after 8s (expected when wedged)" }
  Remove-Item $tOut, $tErr -Force -ErrorAction SilentlyContinue
} catch { Say "  graceful close unavailable ($($_.Exception.Message)), continuing" }

# 2. Kill the handle holders. Path-filtered: agent-browser's own Chrome only.
$procs = @(Get-AgentBrowserProcs)
$killed = 0
foreach ($proc in $procs) {
  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
}
Start-Sleep -Milliseconds 1500
Say "  killed $killed agent-browser-managed process(es)"

# 3. Move stale state aside. NOT deleted, and scoped to this session only, so
#    other projects' named sessions survive untouched.
$stamp  = (Get-Date -Format 'yyyyMMdd-HHmmss')
$backup = Join-Path $abRoot "_unwedge-backup-$Session-$stamp"
$moved  = @()
foreach ($suffix in $STATE_SUFFIXES) {
  $f = Join-Path $abRoot "$Session.$suffix"
  if (Test-Path $f) {
    if (-not (Test-Path $backup)) { $null = New-Item -ItemType Directory -Path $backup }
    Move-Item $f (Join-Path $backup "$Session.$suffix") -Force
    $moved += "$Session.$suffix"
  }
}
if ($moved.Count) { Say "  moved $($moved.Count) state file(s) to $backup"; Say "    $($moved -join ', ')" }
else { Say "  no state files to move" }

# Keep only the 3 newest backups so this script never becomes its own cruft.
$old = @(Get-ChildItem $abRoot -Directory -Filter '_unwedge-backup-*' -ErrorAction SilentlyContinue |
         Sort-Object Name -Descending | Select-Object -Skip 3)
if ($old.Count) {
  $old | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Say "  pruned $($old.Count) older backup dir(s)"
}

# 4. Verify the socket actually released.
Start-Sleep -Milliseconds 500
$stillOwner = Get-ListenerOwner $daemonPort
Say ""
if ($null -ne $stillOwner) {
  Say "STILL WEDGED: port $daemonPort is listening under pid $stillOwner." 'Red'
  Say "Something outside agent-browser holds that socket. Inspect it, or reboot." 'Red'
  exit 2
}

$leftovers = @(Get-AgentBrowserProcs).Count
Say "CLEARED. Port $daemonPort released, $leftovers managed process(es) left." 'Green'
Say "Next 'agent-browser open <url>' should return in about a second." 'Green'
Say "Prevention: always shut down with 'agent-browser close --all'. Never kill its Chrome directly." 'Gray'
exit 0
