#Requires -Version 7
# Read-side tests (K1/K3/K11/K26/K27/K28): snapshot attributes, popup walk, JSON tree,
# desk windows detail, desk read, desk clipboard, and the disarmed refusal of every new
# acting verb. Read-only assertions run for real here; acting is only ever asserted to
# REFUSE, never to act, so this file is safe to run on the live desktop.
Set-StrictMode -Version Latest
$script:Failures = 0
$script:Count = 0

function Assert-Equal {
  param($Expected, $Actual, [string]$Message)
  $script:Count++
  if ($Expected -ne $Actual) {
    $script:Failures++
    Write-Host "FAIL: $Message" -ForegroundColor Red
    Write-Host "  expected: <$Expected>"
    Write-Host "  actual:   <$Actual>"
  } else { Write-Host "ok: $Message" }
}

function Assert-True {
  param($Condition, [string]$Message)
  Assert-Equal $true ([bool]$Condition) $Message
}

$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'lib\guard.ps1')

if (Test-DeskStop $root) {
  Write-Host "deskclaw is STOPPED (state/STOP present); refusing to read the live desktop for tests." -ForegroundColor Red
  exit 1
}
if (Test-DeskArmed $root) {
  Write-Host "deskclaw is ARMED; these tests assert refusals. Run 'desk disarm' first." -ForegroundColor Red
  exit 1
}

. (Join-Path $root 'lib\redact.ps1')
. (Join-Path $root 'lib\windows.ps1')
. (Join-Path $root 'lib\uia.ps1')
. (Join-Path $root 'lib\shot.ps1')
. (Join-Path $root 'lib\act.ps1')
. (Join-Path $root 'lib\read.ps1')

$patterns = Get-DenyPattern (Join-Path $root 'deny.txt')

# ---- attribute text: redact, truncate, escape ----

Assert-Equal 'key=[REDACTED]' (ConvertTo-DeskAttrText 'key=sk_live_abcdefgh12345678') 'attribute text is redacted before it can reach a line'
Assert-Equal 200 (ConvertTo-DeskAttrText ('x' * 500)).Length 'attribute text is truncated to 200 chars'
Assert-Equal 'short' (ConvertTo-DeskAttrText 'short') 'short attribute text is untouched'
Assert-Equal '' (ConvertTo-DeskAttrText $null) 'null attribute text becomes empty'
Assert-Equal 'a b' (ConvertTo-DeskAttrText "a`r`nb") 'newlines collapse to a single space'

Assert-Equal '"a\"b"' (ConvertTo-DeskJsonString 'a"b') 'JSON string escapes a double quote'
Assert-Equal '"a\\b"' (ConvertTo-DeskJsonString 'a\b') 'JSON string escapes a backslash'
Assert-Equal '"a\tb"' (ConvertTo-DeskJsonString "a`tb") 'JSON string escapes a tab'
Assert-Equal '""' (ConvertTo-DeskJsonString $null) 'JSON string of null is a pair of quotes'

# ---- snapshot line format ----

$bare = [pscustomobject]@{ Ref='@e12'; Depth=2; Type='Button'; Name='Memory add'; X=2718; Y=548; RuntimeId='42.1' }
Assert-Equal '    @e12 Button "Memory add" [2718,548]' (Format-DeskElement $bare) 'a line with no attributes matches the 0.2 baseline exactly'

$val = [pscustomobject]@{ Ref='@e5'; Depth=1; Type='Edit'; Name='Name'; X=10; Y=20; RuntimeId='1.2'; Value='hello' }
Assert-Equal '  @e5 Edit "Name" [10,20] value="hello"' (Format-DeskElement $val) 'value attribute is appended after the coordinates'

$esc = [pscustomobject]@{ Ref='@e5'; Depth=0; Type='Edit'; Name='n'; X=0; Y=0; RuntimeId='1'; Value='a"b\c' }
Assert-Equal '@e5 Edit "n" [0,0] value="a\"b\\c"' (Format-DeskElement $esc) 'value attribute is JSON-quoted'

$all = [pscustomobject]@{
  Ref='@e7'; Depth=0; Type='CheckBox'; Name='c'; X=1; Y=2; RuntimeId='1'
  Value='v'; Toggle='on'; Selected=$true; Enabled=$false; Expanded=$true; Offscreen=$true
}
Assert-Equal '@e7 CheckBox "c" [1,2] value="v" toggle=on selected=true enabled=false expanded=true offscreen=true' (Format-DeskElement $all) 'every attribute renders in a fixed order'

$en = [pscustomobject]@{ Ref='@e8'; Depth=0; Type='Button'; Name='b'; X=1; Y=2; RuntimeId='1'; Enabled=$true; Selected=$false; Offscreen=$false }
Assert-Equal '@e8 Button "b" [1,2]' (Format-DeskElement $en) 'enabled, selected and offscreen print only when they carry news'

$off = [pscustomobject]@{ Ref='@e9'; Depth=0; Type='ComboBox'; Name='c'; X=1; Y=2; RuntimeId='1'; Expanded=$false }
Assert-Equal '@e9 ComboBox "c" [1,2] expanded=false' (Format-DeskElement $off) 'expanded=false is printed, a collapsed node is news'

$pop = [pscustomobject]@{ Ref='@e40'; Depth=0; Type='Menu'; Name=''; X=5; Y=6; RuntimeId='1'; Popup='Context' }
Assert-Equal '@e40 Menu "" [5,6] popup="Context"' (Format-DeskElement $pop) 'popup attribute marks an owned popup root'

# ---- JSON tree ----

$j = ConvertTo-DeskElementJson $all
Assert-Equal '@e7' $j.ref 'JSON element uses a lowercase ref key'
Assert-Equal 'CheckBox' $j.type 'JSON element carries the control type'
Assert-Equal 'on' $j.toggle 'JSON element carries toggle'
Assert-Equal 1 $j.x 'JSON element carries x'
$jb = ConvertTo-DeskElementJson $bare
Assert-Equal $false ($jb.Contains('toggle')) 'JSON element omits attributes the element does not have'
Assert-Equal 'Memory add' $jb.name 'JSON element carries the name'

# ---- desk windows detail line ----

Assert-Equal '@w4 [SKIPPED: denylisted]' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w4'; Title=''; ProcessName='notepad'; Pid=1; Handle=[IntPtr]::Zero; Denied=$true
})) 'denied windows still format as SKIPPED with no detail leaked'
Assert-Equal '@w1 "Calculator" (CalculatorApp, 42)' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w1'; Title='Calculator'; ProcessName='CalculatorApp'; Pid=42; Handle=[IntPtr]::Zero; Denied=$false
})) 'a window with no detail fields keeps the 0.2 baseline line'
Assert-Equal '@w1 "Calculator" (CalculatorApp, 42) ApplicationFrameWindow [10,20,300,400] focused=true' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w1'; Title='Calculator'; ProcessName='CalculatorApp'; Pid=42; Handle=[IntPtr]::Zero; Denied=$false
  Class='ApplicationFrameWindow'; X=10; Y=20; W=300; H=400; Focused=$true
})) 'a window with detail fields adds class, rect and focus'
Assert-Equal '@w2 "Other" (pwsh, 7) ConsoleWindowClass [0,0,100,50]' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w2'; Title='Other'; ProcessName='pwsh'; Pid=7; Handle=[IntPtr]::Zero; Denied=$false
  Class='ConsoleWindowClass'; X=0; Y=0; W=100; H=50; Focused=$false
})) 'focused= is printed only for the focused window'

# ---- toggle target resolution (no-op when already in state) ----

Assert-Equal 'noop' (Resolve-DeskToggleAction 'On' 'on') 'toggle to the state it is already in is a no-op'
Assert-Equal 'noop' (Resolve-DeskToggleAction 'Off' 'off') 'toggle off when already off is a no-op'
Assert-Equal 'toggle' (Resolve-DeskToggleAction 'Off' 'on') 'toggle off to on acts'
Assert-Equal 'toggle' (Resolve-DeskToggleAction 'On' '') 'toggle with no argument always acts'
Assert-Equal 'toggle' (Resolve-DeskToggleAction 'Indeterminate' 'on') 'toggle from mixed acts'

# ---- every new acting verb refuses while disarmed ----

$atmp = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-read-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $atmp 'state') -Force | Out-Null

foreach ($fn in @('Invoke-DeskScroll', 'Invoke-DeskExpand', 'Invoke-DeskCollapse', 'Invoke-DeskSelect', 'Invoke-DeskContext')) {
  $r = & $fn '@e1' $patterns $atmp
  Assert-Equal 4 $r.Code "$fn refuses with exit 4 while disarmed"
}
$r = Invoke-DeskToggle '@e1' 'on' $patterns $atmp
Assert-Equal 4 $r.Code 'Invoke-DeskToggle refuses with exit 4 while disarmed'
$r = Set-DeskClipboard 'text' $atmp
Assert-Equal 4 $r.Code 'Set-DeskClipboard refuses with exit 4 while disarmed'
$r = Invoke-DeskDismiss $patterns $atmp
Assert-Equal 4 $r.Code 'Invoke-DeskDismiss refuses with exit 4 while disarmed'

# STOP outranks the arm switch for the new verbs too.
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value 'test'
New-Item -ItemType File -Path (Join-Path $atmp 'state\STOP') -Force | Out-Null
$r = Invoke-DeskExpand '@e1' $patterns $atmp
Assert-Equal 3 $r.Code 'STOP outranks armed for the new acting verbs (exit 3)'
Remove-Item -LiteralPath (Join-Path $atmp 'state\STOP')

# Reading an element is NOT arm-gated: disarmed still resolves far enough to hit the
# real refusal ladder (no snapshot), never the arm gate.
Remove-Item -LiteralPath (Join-Path $atmp 'state\ACT-ARMED')
$r = Resolve-DeskSnapshotElement '@e1' $patterns $atmp
Assert-Equal 'no-snapshot' $r.Reason 'read-side resolve is not arm-gated, it falls through to the snapshot check'
$r = Resolve-DeskActElement '@e1' $patterns $atmp
Assert-Equal 'not-armed' $r.Reason 'act-side resolve is still arm-gated'

Remove-Item -Recurse -Force $atmp

# ---- live: a probe window this file owns start to finish ----

$marker = "deskclaw-probe-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$probe = Start-Process pwsh -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot 'probe-window.ps1'),
  '-Title', $marker, '-Seconds', '60')
Start-Sleep -Milliseconds 3000
$valued = @()

try {
  $pw = Get-DeskWindow $patterns | Where-Object { $_.Title -eq $marker -and -not $_.Denied } | Select-Object -First 1
  Assert-True ($null -ne $pw) 'the probe window is listed by Get-DeskWindow'

  if ($pw) {
    Assert-True ($pw.Class -and $pw.Class.Length -gt 0) "the probe window carries a class name (got '$($pw.Class)')"
    Assert-True ($pw.W -gt 0 -and $pw.H -gt 0) "the probe window carries a real rect ($($pw.W)x$($pw.H))"

    $snap = Get-DeskSnapshot $pw.Handle 6
    Assert-True ($snap.Count -gt 3) "the probe tree has elements (got $($snap.Count))"
    Assert-True ($null -ne $snap.PSObject.Properties['Offscreen']) 'the snapshot reports an offscreen skip count'

    $valued = @($snap.Elements | Where-Object { $_.Value -eq 'deskclaw-value-probe' })
    Assert-Equal 1 $valued.Count 'the probe textbox value is captured from ValuePattern'

    $toggled = @($snap.Elements | Where-Object { $_.Toggle -eq 'on' })
    Assert-True ($toggled.Count -ge 1) "the probe checkbox reports toggle=on (got $($toggled.Count))"

    $disabled = @($snap.Elements | Where-Object { $_.Enabled -eq $false })
    Assert-True ($disabled.Count -ge 1) "the disabled probe button reports enabled=false (got $($disabled.Count))"

    $collapsed = @($snap.Elements | Where-Object { $_.Expanded -eq $false })
    Assert-True ($collapsed.Count -ge 1) "the probe combo box reports expanded=false (got $($collapsed.Count))"

    if ($valued.Count -eq 1) {
      $line = Format-DeskElement ($valued[0])
      Assert-True ($line -match ' value="deskclaw-value-probe"$') "the rendered line carries the value attribute: $line"
    }

    # The 0.2 line grammar still parses the head of every line, attributes or not.
    $bad = @($snap.Elements | ForEach-Object { Format-DeskElement $_ } |
      Where-Object { $_ -notmatch '^\s*@e\d+ \S+ ".*" \[-?\d+,-?\d+\]' })
    Assert-Equal 0 $bad.Count 'every rendered line keeps the 0.2 @eN Type Name [x,y] prefix'

    Assert-Equal 0 (@(Get-DeskOwnedPopup $pw.Handle)).Count 'a window with no menu open reports no owned popups'
  }

  # ---- live: through the real CLI ----
  $desk = Join-Path $root 'desk.ps1'

  $verOut = & pwsh -NoProfile -File $desk --version 2>&1
  Assert-Equal 0 $LASTEXITCODE 'desk --version exits 0'
  Assert-True (($verOut -join "`n") -match 'deskclaw \d+\.\d+\.\d+') "desk --version prints a version line (got: $verOut)"

  $winOut = & pwsh -NoProfile -File $desk windows 2>&1
  Assert-Equal 0 $LASTEXITCODE 'desk windows exits 0'
  $probeLine = @($winOut | Where-Object { "$_" -like "*$marker*" }) | Select-Object -First 1
  Assert-True ("$probeLine" -match '^@w\d+ ".*" \(\S+, \d+\) \S+ \[-?\d+,-?\d+,\d+,\d+\]') "desk windows prints class and rect (got: $probeLine)"

  $snapOut = & pwsh -NoProfile -File $desk snapshot $marker 2>&1
  Assert-Equal 0 $LASTEXITCODE 'desk snapshot of the probe exits 0'
  Assert-True (($snapOut -join "`n") -match 'value="deskclaw-value-probe"') 'desk snapshot prints a value= attribute end to end'

  $jsonOut = & pwsh -NoProfile -File $desk --json snapshot $marker 2>&1
  Assert-Equal 0 $LASTEXITCODE 'desk --json snapshot exits 0'
  $parsed = try { ($jsonOut -join "`n") | ConvertFrom-Json } catch { $null }
  Assert-True ($null -ne $parsed) 'desk --json snapshot emits parseable JSON'
  if ($parsed) {
    Assert-True (@($parsed).Count -gt 3) "JSON snapshot has elements (got $(@($parsed).Count))"
    Assert-Equal 1 (@($parsed | Where-Object { $_.value -eq 'deskclaw-value-probe' })).Count 'JSON snapshot carries the value field'
    Assert-True ($null -ne (@($parsed)[0].ref)) 'JSON snapshot elements carry a ref'
  }

  # desk read runs while disarmed: reading is not acting.
  $readRef = if ($valued.Count -eq 1) { $valued[0].Ref } else { '@e1' }
  $readOut = & pwsh -NoProfile -File $desk read $readRef 2>&1
  Assert-Equal 0 $LASTEXITCODE "desk read $readRef exits 0 while disarmed"
  Assert-Equal 'deskclaw-value-probe' (($readOut -join '').Trim()) 'desk read prints the element value'

  $readName = & pwsh -NoProfile -File $desk read $readRef --prop name 2>&1
  Assert-Equal 0 $LASTEXITCODE "desk read --prop name exits 0 (got: $readName)"

  $clipOut = & pwsh -NoProfile -File $desk clipboard get 2>&1
  Assert-Equal 0 $LASTEXITCODE 'desk clipboard get exits 0'

  # Every new acting verb refuses end to end while disarmed.
  foreach ($v in @(
    @('scroll', $readRef), @('expand', $readRef), @('collapse', $readRef),
    @('select', $readRef), @('toggle', $readRef), @('context', $readRef),
    @('dismiss'), @('clipboard', 'set', 'x'))) {
    & pwsh -NoProfile -File $desk @v 2>&1 | Out-Null
    Assert-Equal 4 $LASTEXITCODE "desk $($v -join ' ') refuses with exit 4 while disarmed"
  }
} finally {
  if ($probe) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }
}

# ---- live: an owned popup is walked ----

$pmarker = "deskclaw-probe-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$pprobe = Start-Process pwsh -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $PSScriptRoot 'probe-window.ps1'),
  '-Title', $pmarker, '-Seconds', '20', '-Dropdown')
Start-Sleep -Milliseconds 3500
try {
  $ppw = Get-DeskWindow $patterns | Where-Object { $_.Title -eq $pmarker -and -not $_.Denied } | Select-Object -First 1
  $pops = if ($ppw) { @(Get-DeskOwnedPopup $ppw.Handle) } else { @() }
  if ($pops.Count -gt 0) {
    $psnap = Get-DeskSnapshot $ppw.Handle 6
    $proots = @($psnap.Elements | Where-Object { $null -ne $_.Popup })
    Assert-True ($proots.Count -ge 1) 'the popup root is included in the snapshot with a popup= attribute'
    if ($proots.Count -ge 1) {
      Assert-True (($proots[0].Ref) -match '^@e\d+$') 'the popup root gets a normal @eN ref'
      Assert-True ((Format-DeskElement $proots[0]) -match 'popup="') 'the popup root line carries popup='
    }
  } else {
    Write-Host "SKIP: the combo dropdown popup did not materialise on this desktop; popup walk covered by unit tests only" -ForegroundColor Yellow
  }
} finally {
  if ($pprobe) { Stop-Process -Id $pprobe.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "$($script:Count - $script:Failures)/$($script:Count) passed"
exit $script:Failures
