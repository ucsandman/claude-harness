#Requires -Version 7
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

# Kill ONLY Calculator processes THIS RUN started. A bare -Name sweep is what
# killed a real Notepad session with unsaved work on 2026-08-12: name matching
# cannot tell the test's process from the user's. Baseline the PIDs that already
# existed before we launch anything, then only ever kill PIDs outside that set.
# (Start-Process calc.exe returns a launcher PID, not the UWP CalculatorApp PID,
# so -PassThru alone is not enough here.)
function Get-CalcPidSet {
  return @(Get-Process -Name CalculatorApp, Calculator -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
}
function Stop-CalcStartedSince {
  param([int[]]$Before)
  foreach ($calcPid in (Get-CalcPidSet)) {
    if ($Before -notcontains $calcPid) {
      Stop-Process -Id $calcPid -Force -ErrorAction SilentlyContinue
    }
  }
}
$script:CalcPidBaseline = Get-CalcPidSet

$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'lib\guard.ps1')

# STOP is a tool invariant, not just dispatcher policy: refuse to read the live
# desktop for tests the same way desk.ps1 refuses to run verbs.
if (Test-DeskStop $root) {
  Write-Host "deskclaw is STOPPED (state/STOP present); refusing to read the live desktop for tests." -ForegroundColor Red
  exit 1
}

. (Join-Path $root 'lib\redact.ps1')

$patterns = Get-DenyPattern (Join-Path $root 'deny.txt')

Assert-True ($patterns.Count -gt 5) 'deny.txt loads several patterns'
Assert-True (Test-Denylisted '.env.dashclaw - Notepad' 'notepad' $patterns) 'real fixture: an open .env is denylisted'
Assert-True (Test-Denylisted 'Vault - 1Password' '1Password' $patterns) 'password manager is denylisted by process'
Assert-True (Test-Denylisted 'id_rsa - Notepad' 'notepad' $patterns) 'private key file is denylisted'
Assert-Equal $false (Test-Denylisted 'README.md - Notepad' 'notepad' $patterns) 'ordinary document is not denylisted'
Assert-Equal $false (Test-Denylisted 'Calculator' 'CalculatorApp' $patterns) 'ordinary app is not denylisted'

Assert-Equal 'key=[REDACTED]' (Protect-Secret 'key=sk_live_abcdefgh12345678') 'stripe-shaped key redacted'
Assert-Equal 'tok [REDACTED]' (Protect-Secret 'tok ghp_ABCDEFGHIJKLMNOP1234') 'github token redacted'
Assert-Equal 'auth Bearer [REDACTED]' (Protect-Secret 'auth Bearer abcdefghijklmnop') 'bearer token redacted'
Assert-Equal 'API_TOKEN=[REDACTED]' (Protect-Secret 'API_TOKEN=abcdefghijklmnopq') 'KEY=long-value redacted'
Assert-Equal 'Display is 0' (Protect-Secret 'Display is 0') 'ordinary UI text untouched'
Assert-Equal 'Memory add' (Protect-Secret 'Memory add') 'ordinary button name untouched'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $tmp 'state') -Force | Out-Null

Assert-Equal $false (Test-DeskStop $tmp) 'no STOP file means not stopped'
New-Item -ItemType File -Path (Join-Path $tmp 'state\STOP') | Out-Null
Assert-True (Test-DeskStop $tmp) 'STOP file present means stopped'
Remove-Item (Join-Path $tmp 'state\STOP')
Assert-Equal $false (Test-DeskStop $tmp) 'removing STOP clears it'

Write-DeskAudit $tmp 'windows' 'all' 'count=12'
$auditPath = Join-Path $tmp 'state\audit.jsonl'
Assert-True (Test-Path $auditPath) 'audit log is created on first write'
$entry = Get-Content $auditPath | Select-Object -Last 1 | ConvertFrom-Json
Assert-Equal 'windows' $entry.verb 'audit entry records the verb'
Assert-Equal 'count=12' $entry.detail 'audit entry records the detail'
# Assert the timestamp against the RAW line, not the parsed object. PowerShell 7's
# ConvertFrom-Json silently converts an ISO-8601 string into a [System.DateTime],
# which then renders as "08/12/2026 14:30:45" and fails an ISO regex. The on-disk
# format is what actually matters here anyway.
$rawEntry = Get-Content $auditPath | Select-Object -Last 1
Assert-True ($rawEntry -match '"ts":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"') 'audit entry has an ISO timestamp'

Write-DeskAudit $tmp 'snapshot' 'Calculator' 'elements=72'
Assert-Equal 2 ((Get-Content $auditPath).Count) 'audit log appends rather than overwrites'

Remove-Item -Recurse -Force $tmp

# Cold start: Write-DeskAudit must create state/ itself, and Test-DeskStop must
# report "not stopped" when the directory does not exist at all.
$cold = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-cold-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $cold -Force | Out-Null
Assert-Equal $false (Test-DeskStop $cold) 'no state dir at all means not stopped'
Write-DeskAudit $cold 'snapshot' 'Calculator' 'elements=72'
Assert-True (Test-Path (Join-Path $cold 'state')) 'Write-DeskAudit creates state/ when it does not exist'
Assert-True (Test-Path (Join-Path $cold 'state\audit.jsonl')) 'cold-start audit log is written'
Remove-Item -Recurse -Force $cold

. (Join-Path $root 'lib\windows.ps1')

$wins = Get-DeskWindow $patterns
Assert-True ($wins.Count -gt 0) 'at least one visible window is found'
Assert-True ($wins[0].Ref -match '^@w\d+$') 'windows get @wN refs'
Assert-True (($wins | Where-Object { $_.Title -and $_.Title.Length -gt 0 }).Count -gt 0) 'some windows have titles'

$denied = $wins | Where-Object { $_.Denied }
foreach ($d in $denied) {
  Assert-Equal '' $d.Title "denied window $($d.Ref) carries no title text"
}
Assert-Equal '@w4 [SKIPPED: denylisted]' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w4'; Title=''; ProcessName='notepad'; Pid=1; Handle=[IntPtr]::Zero; Denied=$true
})) 'denied windows format as SKIPPED with no title'
Assert-Equal '@w1 "Calculator" (CalculatorApp, 42)' (Format-DeskWindow ([pscustomobject]@{
  Ref='@w1'; Title='Calculator'; ProcessName='CalculatorApp'; Pid=42; Handle=[IntPtr]::Zero; Denied=$false
})) 'normal windows format with title, process and pid'

# UWP dedupe: the ApplicationFrameHost shell duplicates the real app window.
$dupes = @(
  [pscustomobject]@{ Title='Calculator'; ProcessName='ApplicationFrameHost'; Pid=1; Handle=[IntPtr]1 },
  [pscustomobject]@{ Title='Calculator'; ProcessName='CalculatorApp';        Pid=2; Handle=[IntPtr]2 },
  [pscustomobject]@{ Title='README.md - Notepad'; ProcessName='notepad';     Pid=3; Handle=[IntPtr]3 }
)
$merged = Merge-UwpWindow $dupes
Assert-Equal 2 $merged.Count 'the ApplicationFrameHost duplicate is dropped'
Assert-Equal 'CalculatorApp' ($merged | Where-Object { $_.Title -eq 'Calculator' }).ProcessName 'the real app window survives, not the shell'

# A lone ApplicationFrameHost window with no twin must be kept, not silently lost.
$lone = @([pscustomobject]@{ Title='Some UWP App'; ProcessName='ApplicationFrameHost'; Pid=4; Handle=[IntPtr]4 })
Assert-Equal 1 (Merge-UwpWindow $lone).Count 'an unpaired shell window is kept'

. (Join-Path $root 'lib\uia.ps1')

# The measured trap: infinite rectangles crash an [int] cast.
Assert-Equal $null (Get-SafeRect ([pscustomobject]@{
  X=[double]::PositiveInfinity; Y=0.0; Width=10.0; Height=10.0 })) 'infinite rect returns null'
Assert-Equal $null (Get-SafeRect ([pscustomobject]@{
  X=[double]::NaN; Y=0.0; Width=10.0; Height=10.0 })) 'NaN rect returns null'
Assert-Equal $null (Get-SafeRect $null) 'null rect returns null'
$ok = Get-SafeRect ([pscustomobject]@{ X=2718.0; Y=548.0; Width=48.0; Height=32.0 })
Assert-Equal 2718 $ok.X 'finite rect keeps its X'
Assert-Equal 548 $ok.Y 'finite rect keeps its Y'

Assert-Equal '    @e12 Button "Memory add" [2718,548]' (Format-DeskElement ([pscustomobject]@{
  Ref='@e12'; Depth=2; Type='Button'; Name='Memory add'; X=2718; Y=548; RuntimeId='42.1' })) 'element line format matches the measured baseline'

# Live check against an app this test owns start to finish.
Start-Process calc.exe
Start-Sleep -Milliseconds 2500
$calc = Get-DeskWindow $patterns | Where-Object { $_.Title -eq 'Calculator' -and -not $_.Denied } | Select-Object -First 1
Assert-True ($null -ne $calc) 'Calculator window is found'
if ($calc) {
  $snap = Get-DeskSnapshot $calc.Handle 6
  Assert-True ($snap.Count -gt 30) "Calculator tree has many elements (got $($snap.Count))"
  Assert-True ($snap.Elements | Where-Object { $_.Name -eq 'Memory add' }) 'the Memory add button is present'
  Assert-Equal 0 (@($snap.Elements | Where-Object { $null -eq $_.X }).Count) 'every element survived rect guarding'
  Assert-True (($snap.Elements | ForEach-Object { $_.Ref }) -join ',' -match '@e1,') 'refs are allocated in document order'
}
Stop-CalcStartedSince $script:CalcPidBaseline

. (Join-Path $root 'lib\shot.ps1')

Start-Process calc.exe
Start-Sleep -Milliseconds 2500
$calc2 = Get-DeskWindow $patterns | Where-Object { $_.Title -eq 'Calculator' -and -not $_.Denied } | Select-Object -First 1
if ($calc2) {
  $shotPath = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-shot-" + [Guid]::NewGuid().ToString('N') + ".png")
  $res = Save-DeskShot $calc2.Handle $shotPath
  Assert-True (Test-Path $res.Path) 'screenshot file is written to disk'
  Assert-True ($res.Bytes -gt 1000) "screenshot is a real image (got $($res.Bytes) bytes)"
  Assert-Equal $shotPath $res.Path 'screenshot honours the requested path'
  Remove-Item $res.Path -Force
}
Stop-CalcStartedSince $script:CalcPidBaseline

# Task 5b: occlusion refusal and Resolve-DeskTarget coverage. Synthetic objects only,
# so none of this depends on what happens to be open on the real desktop.

Assert-Equal $false (Test-RectOverlap `
  ([pscustomobject]@{L=0;T=0;R=10;B=10}) `
  ([pscustomobject]@{L=20;T=20;R=30;B=30})) 'disjoint rects do not overlap'
Assert-Equal $true (Test-RectOverlap `
  ([pscustomobject]@{L=0;T=0;R=10;B=10}) `
  ([pscustomobject]@{L=5;T=5;R=15;B=15})) 'genuinely overlapping rects overlap'
Assert-Equal $true (Test-RectOverlap `
  ([pscustomobject]@{L=0;T=0;R=100;B=100}) `
  ([pscustomobject]@{L=10;T=10;R=20;B=20})) 'one rect fully containing the other overlaps'
Assert-Equal $false (Test-RectOverlap `
  ([pscustomobject]@{L=0;T=0;R=10;B=10}) `
  ([pscustomobject]@{L=10;T=0;R=20;B=10})) 'touching edges do not count as overlap'
Assert-Equal $false (Test-RectOverlap `
  ([pscustomobject]@{L=-32000;T=-32000;R=-31900;B=-31900}) `
  ([pscustomobject]@{L=-31950;T=-31950;R=-31800;B=-31800})) 'a minimised rect never overlaps, even when the numbers would otherwise intersect'

$rtWins = @(
  [pscustomobject]@{ Ref='@w1'; Title='Calculator'; Denied=$false },
  [pscustomobject]@{ Ref='@w2'; Title=''; Denied=$true }
)
$rNoMatch = Resolve-DeskTarget 'NoSuchTitleXYZ' $rtWins 'capture'
Assert-Equal 2 $rNoMatch.Code 'unmatched title resolves to Code 2'

$rDeniedRef = Resolve-DeskTarget '@w2' $rtWins 'capture'
Assert-Equal 2 $rDeniedRef.Code 'a denied window addressed by @wN resolves to Code 2'
Assert-True ($rDeniedRef.Message -like '*denylisted*') 'the denied @wN refusal message mentions denylisted'

$rtDeniedTitle = @([pscustomobject]@{ Ref='@w9'; Title='ShouldNeverMatch'; Denied=$true })
$rDeniedTitle = Resolve-DeskTarget 'ShouldNeverMatch' $rtDeniedTitle 'capture'
Assert-Equal 2 $rDeniedTitle.Code 'a denied window is never resolved via title substring, even carrying title text'

$rNormalRef = Resolve-DeskTarget '@w1' $rtWins 'capture'
Assert-Equal 0 $rNormalRef.Code 'a normal window resolves to Code 0 by @wN'

$rNormalTitle = Resolve-DeskTarget 'Calc' $rtWins 'capture'
Assert-Equal 0 $rNormalTitle.Code 'a normal window resolves to Code 0 by title substring'

# Fix 6: end-to-end occlusion refusal, driven through the real `desk shot` CLI, not
# just the geometry helpers above. A dedicated cmd.exe window (never single-instance,
# unlike Windows 11's tabbed Notepad, which merges into an already-running session
# and made an earlier version of this test kill the developer's real Notepad tabs by
# matching on a bare process name) is given a title containing a fresh GUID marker
# plus 'secrets.env' so it trips the denylist. Selection is by that unique marker and
# cleanup is by the exact PID this test launched — never a generic process name — so
# this cannot touch any pre-existing window or process on the real desktop.
$fix6Marker = "deskclaw-fix6-test-secrets.env-$([Guid]::NewGuid().ToString('N').Substring(0,8))"

if (-not ('DeskTestWin' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskTestWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(
    IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
}

$fix6MarkerProc = Start-Process cmd.exe -ArgumentList "/k title $fix6Marker" -PassThru
Start-Sleep -Milliseconds 1500
$fix6CalcProc = Start-Process calc.exe -PassThru
Start-Sleep -Milliseconds 2500

$fix6Wins = Get-DeskWindow $patterns
$fix6Calc = $fix6Wins | Where-Object { $_.Title -eq 'Calculator' -and -not $_.Denied } | Select-Object -First 1
$fix6Marked = Get-DeskRawWindow | Where-Object { $_.Title -like "*$fix6Marker*" } | Select-Object -First 1

if ($fix6Calc -and $fix6Marked) {
  Assert-True (Test-Denylisted $fix6Marked.Title $fix6Marked.ProcessName $patterns) `
    'the marker window title trips the denylist as expected'

  $fix6CalcRect = Get-DeskWindowRect $fix6Calc.Handle
  # SWP_NOZORDER (0x0004) | SWP_NOACTIVATE (0x0010): reposition only, don't steal focus.
  [void][DeskTestWin]::SetWindowPos(
    $fix6Marked.Handle, [IntPtr]::Zero,
    $fix6CalcRect.L, $fix6CalcRect.T,
    ($fix6CalcRect.R - $fix6CalcRect.L), ($fix6CalcRect.B - $fix6CalcRect.T),
    0x0014)
  Start-Sleep -Milliseconds 500

  $fix6ShotsDir = Join-Path $root 'state\shots'
  $fix6Before = @(if (Test-Path $fix6ShotsDir) { Get-ChildItem $fix6ShotsDir -Filter *.png | Select-Object -ExpandProperty FullName } else { @() })

  & pwsh -NoProfile -File (Join-Path $root 'desk.ps1') shot Calculator
  $fix6ExitCode = $LASTEXITCODE

  $fix6After = @(if (Test-Path $fix6ShotsDir) { Get-ChildItem $fix6ShotsDir -Filter *.png | Select-Object -ExpandProperty FullName } else { @() })

  Assert-Equal 2 $fix6ExitCode 'desk shot exits 2 end-to-end when a denylisted window overlaps the target'
  Assert-Equal $fix6Before.Count $fix6After.Count 'no new screenshot is written when the target is occluded'

  # Defensive cleanup: delete anything the refusal should have prevented from existing.
  foreach ($nf in $fix6After) {
    if ($fix6Before -notcontains $nf) { Remove-Item -LiteralPath $nf -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "SKIP: Fix 6 end-to-end occlusion test - could not find the marker or Calculator window" -ForegroundColor Yellow
}

# Cleanup is scoped strictly to the exact PIDs this test launched, never to a bare
# process-name match (see the incident this comment sits above).
if ($fix6MarkerProc) { Stop-Process -Id $fix6MarkerProc.Id -Force -ErrorAction SilentlyContinue }
if ($fix6CalcProc) { Stop-Process -Id $fix6CalcProc.Id -Force -ErrorAction SilentlyContinue }
Stop-CalcStartedSince $script:CalcPidBaseline

. (Join-Path $root 'lib\viewer.ps1')

# Fix 7: Test-DeskViewerOrigin must require an EXACT match (or a trailing-slash
# prefix), not a bare StartsWith — "http://localhost:48490" must not pass a
# "http://localhost:4849" check just because it shares the numeric prefix.
Assert-True (Test-DeskViewerOrigin 'http://localhost:4849' $null 4849) 'exact Origin is accepted'
Assert-Equal $false (Test-DeskViewerOrigin 'http://localhost:9999' $null 4849) 'mismatched Origin is rejected'
Assert-True (Test-DeskViewerOrigin $null 'http://localhost:4849/' 4849) 'absent Origin with a valid Referer is accepted'
Assert-Equal $false (Test-DeskViewerOrigin $null 'http://localhost:48490/' 4849) 'the 48490-prefix trick is rejected'
Assert-Equal $false (Test-DeskViewerOrigin $null $null 4849) 'neither Origin nor Referer present is rejected'

# Fix round 1: a web page controls its own tab title (document.title). That title
# flows into last-snapshot.json / audit.jsonl via `desk snapshot`/`desk windows`,
# and the viewer renders both raw inside <pre> tags. <pre> stops whitespace
# collapsing, not HTML parsing, so an unencoded value is a stored-XSS path into
# the viewer page. This is the regression guard for that fix.
$vtmp = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-viewer-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $vtmp 'state') -Force | Out-Null

[pscustomobject]@{ window = '<script>alert(1)</script>'; handle = 1; elements = @() } |
  ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $vtmp 'state\last-snapshot.json') -Encoding UTF8
Write-DeskAudit $vtmp 'snapshot' 'x' '<img src=x onerror=1>'

$vhtml = Get-DeskViewerHtml $vtmp
Assert-Equal $false ($vhtml.Contains('<script>alert')) 'viewer HTML never contains an unescaped <script> tag from a window title'
Assert-True ($vhtml.Contains('&lt;script&gt;')) 'viewer HTML contains the HTML-encoded form of the script tag'
Assert-Equal $false ($vhtml.Contains('<img src=x onerror=1>')) 'viewer HTML never contains an unescaped <img> tag from the audit log'
Assert-True ($vhtml.Contains('&lt;img')) 'viewer HTML contains the HTML-encoded form of the img tag'

Remove-Item -Recurse -Force $vtmp

# Fix 4: a truncated or corrupt state file must not take the whole viewer page down
# with it. The button is the only UI route back to clearing STOP, so it must still
# render even when every state file is unreadable garbage.
$ctmp = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-corrupt-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $ctmp 'state') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $ctmp 'state\last-snapshot.json') -Value '{not valid json' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $ctmp 'state\audit.jsonl') -Value '' -Encoding UTF8
New-Item -ItemType File -Path (Join-Path $ctmp 'state\STOP') -Force | Out-Null
# deny.txt intentionally absent from $ctmp too.

$chtml = Get-DeskViewerHtml $ctmp
Assert-True ($chtml.Contains('<form') -and $chtml.Contains('<button')) 'viewer page still renders the form and button when every state file is corrupt or missing'
Assert-True ($chtml.Contains('STOPPED')) 'viewer page still reports STOP status correctly when state is corrupt'
Assert-True ($chtml.Contains('(unreadable)')) 'corrupt last-snapshot.json renders as a placeholder instead of crashing the page'

Remove-Item -Recurse -Force $ctmp

# ---- stage 2 (act) ----
# All headless: these prove the refusal paths (the L1 way — watch each gate
# actually fail), never a live click. The live click is a manual, armed test.
. (Join-Path $root 'lib\act.ps1')

Assert-Equal 'a{+}b' (ConvertTo-SendKeysLiteral 'a+b') 'SendKeys: + escaped'
Assert-Equal '{{}x{}}' (ConvertTo-SendKeysLiteral '{x}') 'SendKeys: braces escaped'
Assert-Equal '50{%} done{^}{~}' (ConvertTo-SendKeysLiteral '50% done^~') 'SendKeys: % ^ ~ escaped'
Assert-Equal 'plain text 123' (ConvertTo-SendKeysLiteral 'plain text 123') 'SendKeys: plain text untouched'

$atmp = Join-Path ([IO.Path]::GetTempPath()) ("deskclaw-act-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $atmp 'state') -Force | Out-Null

$g = Test-DeskActGate $atmp
Assert-Equal 4 $g.Code 'act gate: disarmed refuses with exit 4'
Assert-Equal 'not-armed' $g.Reason 'act gate: disarmed reason is not-armed'

Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value 'test'
Assert-Equal $null (Test-DeskActGate $atmp) 'act gate: armed and not stopped passes'

New-Item -ItemType File -Path (Join-Path $atmp 'state\STOP') -Force | Out-Null
$g = Test-DeskActGate $atmp
Assert-Equal 3 $g.Code 'act gate: STOP outranks armed (exit 3)'
Remove-Item -LiteralPath (Join-Path $atmp 'state\STOP')

# Timed arming (desk arm). Future expiry passes, past expiry and garbage refuse.
$future = (Get-Date).ToUniversalTime().AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ssZ')
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value @('armed from cli', "expires=$future")
Assert-Equal $null (Test-DeskActGate $atmp) 'act gate: unexpired timed arm passes'
$past = (Get-Date).ToUniversalTime().AddMinutes(-5).ToString('yyyy-MM-ddTHH:mm:ssZ')
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value @('armed from cli', "expires=$past")
$g = Test-DeskActGate $atmp
Assert-Equal 4 $g.Code 'act gate: expired timed arm refuses (exit 4)'
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value @('armed from cli', 'expires=not-a-date')
$g = Test-DeskActGate $atmp
Assert-Equal 4 $g.Code 'act gate: unparseable expiry fails closed (exit 4)'
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value 'test'

# Resolve refusal ladder, armed throughout. Each step is made to fail on purpose.
$r = Resolve-DeskActElement '@e1' @('1password') $atmp
Assert-Equal 'no-snapshot' $r.Reason 'resolve: missing snapshot refuses'

Set-Content -LiteralPath (Join-Path $atmp 'state\last-snapshot.json') -Value '{not json' -Encoding UTF8
$r = Resolve-DeskActElement '@e1' @('1password') $atmp
Assert-Equal 'snapshot-corrupt' $r.Reason 'resolve: corrupt snapshot refuses'

[pscustomobject]@{ window = 't'; handle = 1; elements = @(
  [pscustomobject]@{ Ref = '@e1'; RuntimeId = '' }
) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $atmp 'state\last-snapshot.json') -Encoding UTF8
$r = Resolve-DeskActElement '@e9' @('1password') $atmp
Assert-Equal 'ref-not-found' $r.Reason 'resolve: unknown ref refuses'
$r = Resolve-DeskActElement '@e1' @('1password') $atmp
Assert-Equal 'no-runtime-id' $r.Reason 'resolve: element without RuntimeId refuses'

[pscustomobject]@{ window = 't'; handle = 1; elements = @(
  [pscustomobject]@{ Ref = '@e1'; RuntimeId = '42.7' }
) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $atmp 'state\last-snapshot.json') -Encoding UTF8
$r = Resolve-DeskActElement '@e1' @('1password') $atmp
Assert-Equal 'window-gone' $r.Reason 'resolve: dead window handle refuses (never a coordinate fallback)'

# Viewer shows and controls the arm state.
Remove-Item -LiteralPath (Join-Path $atmp 'state\ACT-ARMED')
$ahtml = Get-DeskViewerHtml $atmp
Assert-True ($ahtml.Contains('action="/arm"')) 'viewer: disarmed page offers the Arm button'
Set-Content -LiteralPath (Join-Path $atmp 'state\ACT-ARMED') -Value 'test'
$ahtml = Get-DeskViewerHtml $atmp
Assert-True ($ahtml.Contains('action="/disarm"')) 'viewer: armed page offers the Disarm button'

Remove-Item -Recurse -Force $atmp

Write-Host ""
Write-Host "$($script:Count - $script:Failures)/$($script:Count) passed"
exit $script:Failures
