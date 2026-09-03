#Requires -Version 7
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\redact.ps1')
. (Join-Path $PSScriptRoot 'lib\guard.ps1')
. (Join-Path $PSScriptRoot 'lib\windows.ps1')
. (Join-Path $PSScriptRoot 'lib\uia.ps1')
. (Join-Path $PSScriptRoot 'lib\shot.ps1')
. (Join-Path $PSScriptRoot 'lib\act.ps1')
. (Join-Path $PSScriptRoot 'lib\read.ps1')

$root = $PSScriptRoot
$DeskVersion = '0.3.0'

# Contract flags are stripped before the verb, so `desk --json snapshot X` and
# `desk snapshot X` reach the same dispatcher.
$argv = @($args)
$asJson = $false
while ($argv.Count -gt 0 -and $argv[0] -eq '--json') {
  $asJson = $true
  $argv = if ($argv.Count -gt 1) { @($argv[1..($argv.Count - 1)]) } else { @() }
}
$verb = if ($argv.Count -gt 0) { [string]$argv[0] } else { 'help' }

# Version reads nothing, so it answers ahead of STOP and the denylist check.
if ($verb -in @('--version', '-v', 'version')) {
  Write-Host "deskclaw $DeskVersion"
  exit 0
}

if ($verb -eq 'viewer') {
  . (Join-Path $PSScriptRoot 'lib\viewer.ps1')
  $port = if ($argv.Count -gt 1) { [int]$argv[1] } else { 4849 }
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

# Every element verb below has the same shape: resolve @eN live, act, report. This
# keeps each case in the switch to the two lines that differ.
function Invoke-DeskElementVerb {
  param([string]$Name, [string]$Ref, [scriptblock]$Action, [string]$Past)
  if (-not $Ref) {
    Write-Error "usage: desk $Name <@eN>" -ErrorAction Continue
    exit 2
  }
  $r = & $Action
  if ($r.Code -ne 0) {
    Write-Error $r.Message -ErrorAction Continue
    Write-DeskAudit $root $Name $Ref "refused=$($r.Reason)"
    exit $r.Code
  }
  Write-Host "$Past $Ref in `"$($r.Window.Title)`" ($($r.Detail))"
  Write-DeskAudit $root $Name $Ref "ok;$($r.Detail)"
  exit 0
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
    $target = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    $wins = Get-DeskWindow $patterns
    $r = Resolve-DeskTarget $target $wins 'read'
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'snapshot' $target "refused=$($r.Reason)"
      exit $r.Code
    }
    $win = $r.Window

    $snap = Get-DeskSnapshot $win.Handle 6
    if ($asJson) {
      $rows = @($snap.Elements | ForEach-Object { ConvertTo-DeskElementJson $_ })
      Write-Host ($rows | ConvertTo-Json -Depth 4 -AsArray)
    } else {
      foreach ($e in $snap.Elements) { Format-DeskElement $e }
      # Skipped elements are invisible in the tree by design, so say how many there
      # were: "no Save button" and "the Save button is offscreen" are different bugs.
      if ($snap.Offscreen -gt 0) { Write-Host "# offscreen=$($snap.Offscreen)" }
    }
    $statePath = Join-Path $root 'state\last-snapshot.json'
    New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
    [pscustomobject]@{
      window = $win.Title; handle = [int64]$win.Handle; elements = $snap.Elements
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-DeskAudit $root 'snapshot' $win.Title "elements=$($snap.Count);offscreen=$($snap.Offscreen)"
    if ($snap.Count -lt 5) {
      Write-Error "tree has $($snap.Count) elements; this window likely needs stage 3 (canvas app)" -ErrorAction Continue
      exit 2
    }
    exit 0
  }
  'read' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    $prop = 'value'
    for ($i = 2; $i -lt $argv.Count; $i++) {
      if ($argv[$i] -eq '--prop' -and $i + 1 -lt $argv.Count) { $prop = [string]$argv[$i + 1] }
    }
    if (-not $ref) {
      Write-Error "usage: desk read <@eN> [--prop value|name|text|toggle|selected|enabled]" -ErrorAction Continue
      exit 2
    }
    $r = Read-DeskElementProperty $ref $prop $patterns $root
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'read' $ref "refused=$($r.Reason);prop=$prop"
      exit $r.Code
    }
    Write-Host $r.Text
    # Property NAME and length only: the value itself is the thing we just decided the
    # caller may see, not the thing the audit log should keep.
    Write-DeskAudit $root 'read' $ref "ok;prop=$prop;chars=$($r.Text.Length)"
    exit 0
  }
  'clipboard' {
    $sub = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    if ($sub -eq 'get') {
      $t = Get-DeskClipboard
      Write-Host $t
      Write-DeskAudit $root 'clipboard' 'get' "ok;chars=$($t.Length)"
      exit 0
    }
    if ($sub -eq 'set') {
      $text = if ($argv.Count -gt 2) { [string]$argv[2] } else { '' }
      $r = Set-DeskClipboard $text $root
      if ($r.Code -ne 0) {
        Write-Error $r.Message -ErrorAction Continue
        Write-DeskAudit $root 'clipboard' 'set' "refused=$($r.Reason)"
        exit $r.Code
      }
      Write-Host "clipboard set ($($r.Detail))"
      Write-DeskAudit $root 'clipboard' 'set' "ok;$($r.Detail)"
      exit 0
    }
    Write-Error "usage: desk clipboard get | desk clipboard set `"<text>`"" -ErrorAction Continue
    exit 2
  }
  'shot' {
    $target = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
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
    $minutes = if ($argv.Count -gt 1) { [int]$argv[1] } else { 30 }
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
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
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
  'scroll' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    Invoke-DeskElementVerb 'scroll' $ref { Invoke-DeskScroll $ref $patterns $root } 'scrolled'
  }
  'expand' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    Invoke-DeskElementVerb 'expand' $ref { Invoke-DeskExpand $ref $patterns $root } 'expanded'
  }
  'collapse' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    Invoke-DeskElementVerb 'collapse' $ref { Invoke-DeskCollapse $ref $patterns $root } 'collapsed'
  }
  'select' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    Invoke-DeskElementVerb 'select' $ref { Invoke-DeskSelect $ref $patterns $root } 'selected'
  }
  'context' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    Invoke-DeskElementVerb 'context' $ref { Invoke-DeskContext $ref $patterns $root } 'context-clicked'
  }
  'toggle' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    $want = if ($argv.Count -gt 2) { [string]$argv[2] } else { '' }
    Invoke-DeskElementVerb 'toggle' $ref { Invoke-DeskToggle $ref $want $patterns $root } 'toggled'
  }
  'dismiss' {
    $r = Invoke-DeskDismiss $patterns $root
    if ($r.Code -ne 0) {
      Write-Error $r.Message -ErrorAction Continue
      Write-DeskAudit $root 'dismiss' 'foreground' "refused=$($r.Reason)"
      exit $r.Code
    }
    Write-Host "dismissed `"$($r.Window.Title)`" ($($r.Detail))"
    Write-DeskAudit $root 'dismiss' 'foreground' "ok;$($r.Detail)"
    exit 0
  }
  'type' {
    $ref = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    $text = if ($argv.Count -gt 2) { [string]$argv[2] } else { '' }
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
    $target = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
    $keys = if ($argv.Count -gt 2) { [string]$argv[2] } else { '' }
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
    $target = if ($argv.Count -gt 1) { [string]$argv[1] } else { '' }
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
    Write-Host "deskclaw $DeskVersion - desktop eye (stage 1: read, stage 2: act)"
    Write-Host "  desk --version    print the version and exit"
    Write-Host "  desk windows    list visible top-level windows (class, rect, focus)"
    Write-Host "  desk snapshot <@wN|title>    dump the UIA tree of a window, with attributes and owned popups"
    Write-Host "  desk --json snapshot <@wN|title>    the same tree as a JSON array"
    Write-Host "  desk read <@eN> [--prop value|name|text|toggle|selected|enabled]    read one property"
    Write-Host "  desk clipboard get    print the clipboard (redacted)"
    Write-Host "  desk shot <@wN|title>    save a screenshot to disk (path and size only, never content)"
    Write-Host "  desk viewer [port]    local control page, default http://localhost:4849"
    Write-Host "  desk arm [minutes]    arm acting for N minutes (default 30, auto-expires)"
    Write-Host "  desk disarm    disarm acting now"
    Write-Host "  -- acting verbs below refuse (exit 4) until armed (desk arm, or viewer for no expiry) --"
    Write-Host "  desk click <@eN>    invoke an element from the last snapshot (re-resolved live)"
    Write-Host "  desk type <@eN> `"text`"    set/type text into an element"
    Write-Host "  desk scroll <@eN>    bring an element into view"
    Write-Host "  desk expand <@eN> / desk collapse <@eN>    open or close a tree node, combo or menu"
    Write-Host "  desk select <@eN>    select a list item, tab or row"
    Write-Host "  desk toggle <@eN> [on|off]    flip a checkbox (no-op when already in state)"
    Write-Host "  desk context <@eN>    open the element's context menu"
    Write-Host "  desk dismiss    send Escape to the focused window"
    Write-Host "  desk clipboard set `"text`"    put text on the clipboard"
    Write-Host "  desk key <@wN|title> `"{ENTER}`"    send SendKeys syntax to a window"
    Write-Host "  desk focus <@wN|title>    bring a window to the foreground"
    exit 0
  }
}
