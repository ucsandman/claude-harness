#Requires -Version 7
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\redact.ps1')
. (Join-Path $PSScriptRoot 'lib\guard.ps1')
. (Join-Path $PSScriptRoot 'lib\windows.ps1')
. (Join-Path $PSScriptRoot 'lib\uia.ps1')
. (Join-Path $PSScriptRoot 'lib\shot.ps1')
. (Join-Path $PSScriptRoot 'lib\act.ps1')

$root = $PSScriptRoot
$verb = if ($args.Count -gt 0) { $args[0] } else { 'help' }

if ($verb -eq 'viewer') {
  . (Join-Path $PSScriptRoot 'lib\viewer.ps1')
  $port = if ($args.Count -gt 1) { [int]$args[1] } else { 4849 }
  Start-DeskViewer $PSScriptRoot $port
  exit 0
}

if (Test-DeskStop $root) {
  Write-DeskAudit $root $verb 'n/a' 'refused=stop'
  Write-Error "deskclaw is STOPPED (state/STOP present). Clear it in the viewer to resume." -ErrorAction Continue
  exit 3
}

$patterns = Get-DenyPattern (Join-Path $root 'deny.txt')
if (@($patterns).Count -eq 0) {
  Write-DeskAudit $root $verb 'n/a' 'refused=deny-list-empty'
  Write-Error "deny.txt is missing or empty at $(Join-Path $root 'deny.txt'); refusing to run without a denylist. Restore deny.txt (or add patterns to it) and try again." -ErrorAction Continue
  exit 1
}

switch ($verb) {
  'windows' {
    $wins = @(Get-DeskWindow $patterns)
    foreach ($w in $wins) { Format-DeskWindow $w }
    $deniedCount = @($wins | Where-Object { $_.Denied }).Count
    Write-DeskAudit $root 'windows' 'all' "count=$($wins.Count);denied=$deniedCount"
    exit 0
  }
  'snapshot' {
    $target = if ($args.Count -gt 1) { $args[1] } else { '' }
    $wins = Get-DeskWindow $patterns
    $r = Resolve-DeskTarget $target $wins 'read'
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'snapshot' $target "refused=$($r.Reason)"
      exit $r.Code
    }
    $win = $r.Window

    $snap = Get-DeskSnapshot $win.Handle 6
    foreach ($e in $snap.Elements) { Format-DeskElement $e }
    $statePath = Join-Path $root 'state\last-snapshot.json'
    New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
    [pscustomobject]@{
      window = $win.Title; handle = [int64]$win.Handle; elements = $snap.Elements
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-DeskAudit $root 'snapshot' $win.Title "elements=$($snap.Count)"
    if ($snap.Count -lt 5) {
      Write-Error "tree has $($snap.Count) elements; this window likely needs stage 3 (canvas app)" -ErrorAction Continue
      exit 2
    }
    exit 0
  }
  'shot' {
    $target = if ($args.Count -gt 1) { $args[1] } else { '' }
    $wins = Get-DeskWindow $patterns
    $r = Resolve-DeskTarget $target $wins 'capture'
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'shot' $target "refused=$($r.Reason)"
      exit $r.Code
    }
    $win = $r.Window

    # Occlusion guard. Screen capture takes whatever pixels are visible inside the
    # target's rectangle, not the target's own content, so a denylisted window sitting
    # on top of it lands in the image even though it was never the target. This must
    # fail CLOSED at every point: an unprovable rectangle refuses, it never skips.
    $targetRect = Get-DeskWindowRect $win.Handle
    if ($null -eq $targetRect) {
      Write-Error "cannot determine the target window's rectangle; refusing to capture" -ErrorAction Continue
      Write-DeskAudit $root 'shot' $win.Ref 'refused=occlusion;reason=target-rect-unknown'
      exit 2
    }

    # Drive the loop from the RAW enumeration (includes titleless windows) rather than
    # the display list, so a visible-but-titleless overlay — a credential prompt, a
    # password-manager popup — cannot slip through just because it never made $wins.
    foreach ($rw in Get-DeskRawWindow) {
      if ($rw.Handle -eq $win.Handle) { continue }

      $classifiable = ($rw.ProcessName -ne 'unknown') -or ($rw.Title.Length -gt 0)
      # A window that cannot be classified (no title, no resolvable process) cannot be
      # proven safe by Test-Denylisted either — treat it exactly like a denylisted
      # window for the overlap check rather than silently trusting it.
      $blocking = if ($classifiable) { Test-Denylisted $rw.Title $rw.ProcessName $patterns } else { $true }
      if (-not $blocking) { continue }

      $ident = ($wins | Where-Object { $_.Handle -eq $rw.Handle } | Select-Object -First 1).Ref
      if (-not $ident) { $ident = "handle=$($rw.Handle)" }

      $rr = Get-DeskWindowRect $rw.Handle
      if ($null -eq $rr -or (Test-RectOverlap $targetRect $rr)) {
        Write-Error "$ident (denylisted or unclassifiable) may overlap the target window; refusing to capture" -ErrorAction Continue
        Write-DeskAudit $root 'shot' $win.Ref "refused=occlusion;window=$ident"
        exit 2
      }
    }

    $shotDir = Join-Path $root 'state\shots'
    New-Item -ItemType Directory -Path $shotDir -Force | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    $out = Join-Path $shotDir "$stamp.png"
    $res = Save-DeskShot $win.Handle $out
    # Path and size only. Never image content.
    Write-Host "$($res.Path) ($($res.Bytes) bytes)"
    Write-DeskAudit $root 'shot' $win.Title "bytes=$($res.Bytes)"
    exit 0
  }
  'arm' {
    $minutes = if ($args.Count -gt 1) { [int]$args[1] } else { 30 }
    if ($minutes -lt 1) {
      Write-Error "arm needs a positive number of minutes" -ErrorAction Continue
      exit 1
    }
    $exp = (Get-Date).ToUniversalTime().AddMinutes($minutes).ToString('yyyy-MM-ddTHH:mm:ssZ')
    New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'state\ACT-ARMED') -Value @("armed from cli", "expires=$exp")
    Write-Host "acting armed for $minutes min (until $exp). Disarm early: desk disarm"
    Write-DeskAudit $root 'arm' 'n/a' "armed=set;source=cli;minutes=$minutes"
    exit 0
  }
  'disarm' {
    Remove-Item -LiteralPath (Join-Path $root 'state\ACT-ARMED') -ErrorAction SilentlyContinue
    Write-Host "acting disarmed"
    Write-DeskAudit $root 'disarm' 'n/a' 'armed=cleared;source=cli'
    exit 0
  }
  'click' {
    $ref = if ($args.Count -gt 1) { $args[1] } else { '' }
    $r = Invoke-DeskClick $ref $patterns
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'click' $ref "refused=$($r.Reason)"
      exit $r.Code
    }
    Write-Host "clicked $ref in `"$($r.Window.Title)`" ($($r.Detail))"
    Write-DeskAudit $root 'click' $ref "ok;$($r.Detail)"
    exit 0
  }
  'type' {
    $ref = if ($args.Count -gt 1) { $args[1] } else { '' }
    $text = if ($args.Count -gt 2) { [string]$args[2] } else { '' }
    $r = Invoke-DeskType $ref $text $patterns
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'type' $ref "refused=$($r.Reason)"
      exit $r.Code
    }
    # Length only, never the text: typed content may be sensitive.
    Write-Host "typed $($text.Length) chars into $ref in `"$($r.Window.Title)`" ($($r.Detail))"
    Write-DeskAudit $root 'type' $ref "ok;$($r.Detail)"
    exit 0
  }
  'key' {
    $target = if ($args.Count -gt 1) { $args[1] } else { '' }
    $keys = if ($args.Count -gt 2) { [string]$args[2] } else { '' }
    if (-not $keys) {
      Write-Error "usage: desk key <@wN|title> `"<SendKeys>`"" -ErrorAction Continue
      exit 2
    }
    $wins = Get-DeskWindow $patterns
    $r0 = Resolve-DeskTarget $target $wins 'send keys to'
    if ($r0.Code -ne 0) {
      Write-Error $r0.Message -ErrorAction Continue
      Write-DeskAudit $root 'key' $target "refused=$($r0.Reason)"
      exit $r0.Code
    }
    $r = Invoke-DeskKey $r0.Window $keys
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'key' $r0.Window.Ref "refused=$($r.Reason)"
      exit $r.Code
    }
    Write-Host "sent keys to `"$($r.Window.Title)`" ($($r.Detail))"
    Write-DeskAudit $root 'key' $r0.Window.Ref "ok;$($r.Detail)"
    exit 0
  }
  'focus' {
    $target = if ($args.Count -gt 1) { $args[1] } else { '' }
    $wins = Get-DeskWindow $patterns
    $r0 = Resolve-DeskTarget $target $wins 'focus'
    if ($r0.Code -ne 0) {
      Write-Error $r0.Message -ErrorAction Continue
      Write-DeskAudit $root 'focus' $target "refused=$($r0.Reason)"
      exit $r0.Code
    }
    $r = Invoke-DeskFocus $r0.Window
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'focus' $r0.Window.Ref "refused=$($r.Reason)"
      exit $r.Code
    }
    Write-Host "focused `"$($r.Window.Title)`""
    Write-DeskAudit $root 'focus' $r0.Window.Ref 'ok'
    exit 0
  }
  default {
    Write-Host "deskclaw - desktop eye (stage 1: read, stage 2: act)"
    Write-Host "  desk windows    list visible top-level windows"
    Write-Host "  desk snapshot <@wN|title>    dump the UIA tree of a window"
    Write-Host "  desk shot <@wN|title>    save a screenshot to disk (path and size only, never content)"
    Write-Host "  desk viewer [port]    local control page, default http://localhost:4849"
    Write-Host "  desk arm [minutes]    arm acting for N minutes (default 30, auto-expires)"
    Write-Host "  desk disarm    disarm acting now"
    Write-Host "  -- acting verbs below refuse (exit 4) until armed (desk arm, or viewer for no expiry) --"
    Write-Host "  desk click <@eN>    invoke an element from the last snapshot (re-resolved live)"
    Write-Host "  desk type <@eN> `"text`"    set/type text into an element"
    Write-Host "  desk key <@wN|title> `"{ENTER}`"    send SendKeys syntax to a window"
    Write-Host "  desk focus <@wN|title>    bring a window to the foreground"
    exit 0
  }
}
