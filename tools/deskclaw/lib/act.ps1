Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DeskAct' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskAct {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
}

# Stage 2 safety model, same shape as stage 1: every refusal is the tool working.
#  - STOP and the arm switch are checked INSIDE each acting function, not only in
#    the dispatcher — dot-sourcing this lib does not bypass them.
#  - Acting is OFF unless state\ACT-ARMED exists and has not expired. The
#    viewer arms permanently; `desk arm [minutes]` arms with an expiry
#    (default 30 min, decision 2026-08-13). STOP from the viewer disarms, and
#    STOP always outranks the arm switch.
#  - Elements are re-resolved by UIA RuntimeId against a FRESH snapshot at act
#    time. last-snapshot.json stores a point, not a rect, and no function here
#    accepts a coordinate — there is deliberately nothing to fall back on when
#    the element is gone: the answer is re-snapshot, never click-where-it-was.

function Deny-DeskAct {
  param([int]$Code, [string]$Reason, [string]$Message)
  return [pscustomobject]@{ Code = $Code; Reason = $Reason; Message = $Message; Element = $null; Window = $null }
}

# Gate every act. Refusal order matters: STOP outranks the arm switch.
function Test-DeskActGate {
  param([string]$Root)
  if (Test-DeskStop $Root) {
    return Deny-DeskAct 3 'stop' 'deskclaw is STOPPED (state/STOP present). Clear it in the viewer to resume.'
  }
  if (-not (Test-DeskArmed $Root)) {
    return Deny-DeskAct 4 'not-armed' 'acting is not armed (or the arm expired). Run "desk arm [minutes]" or click Arm in the viewer.'
  }
  return $null
}

# SendKeys treats + ^ % ~ ( ) { } [ ] as syntax; wrap each in braces so typed
# text arrives literally.
function ConvertTo-SendKeysLiteral {
  param([string]$Text)
  return [regex]::Replace($Text, '([+^%~(){}\[\]])', '{$1}')
}

# Walk the live UIA tree of a window and return the raw AutomationElement whose
# RuntimeId matches. Offscreen elements are skipped, exactly like the snapshot
# walk: an element you cannot see is an element you cannot act on.
function Find-DeskAutomationElement {
  param([IntPtr]$Handle, [string]$RuntimeId, [int]$MaxDepth = 6)
  $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if ($null -eq $rootEl) { return $null }
  $stack = New-Object Collections.Generic.Stack[object]
  $stack.Push(@($rootEl, 0))
  while ($stack.Count -gt 0) {
    $pair = $stack.Pop()
    $node = $pair[0]; $level = [int]$pair[1]
    if ($level -gt $MaxDepth) { continue }
    $kids = $node.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($k in $kids) {
      if ($k.Current.IsOffscreen) { continue }
      $rid = try { ($k.GetRuntimeId() -join '.') } catch { '' }
      if ($rid -and $rid -eq $RuntimeId) { return $k }
      $stack.Push(@($k, ($level + 1)))
    }
  }
  return $null
}

# Resolve an @eN ref from last-snapshot.json to a LIVE element. Every step that
# cannot be proven refuses (Code 2); nothing degrades to coordinates.
function Resolve-DeskActElement {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }

  $snapPath = Join-Path $Root 'state\last-snapshot.json'
  if (-not (Test-Path -LiteralPath $snapPath)) {
    return Deny-DeskAct 2 'no-snapshot' "no snapshot exists; run 'desk snapshot <window>' first"
  }
  $snap = try { Get-Content -LiteralPath $snapPath -Raw | ConvertFrom-Json } catch { $null }
  if ($null -eq $snap) {
    return Deny-DeskAct 2 'snapshot-corrupt' 'last-snapshot.json is unreadable; re-run desk snapshot'
  }

  $entry = @($snap.elements) | Where-Object { $_.Ref -eq $Ref } | Select-Object -First 1
  if ($null -eq $entry) {
    return Deny-DeskAct 2 'ref-not-found' "no element '$Ref' in the last snapshot; re-run desk snapshot"
  }
  if ([string]::IsNullOrEmpty($entry.RuntimeId)) {
    return Deny-DeskAct 2 'no-runtime-id' "'$Ref' has no stable identity; refusing to act on it"
  }

  $handle = [IntPtr][int64]$snap.handle
  # Re-check the WINDOW as it is now, not as it was at snapshot time: it may
  # have navigated to a denylisted page, or become unclassifiable.
  $rw = @(Get-DeskRawWindow) | Where-Object { $_.Handle -eq $handle } | Select-Object -First 1
  if ($null -eq $rw) {
    return Deny-DeskAct 2 'window-gone' 'the snapshotted window no longer exists'
  }
  $classifiable = ($rw.ProcessName -ne 'unknown') -or ($rw.Title.Length -gt 0)
  if (-not $classifiable) {
    return Deny-DeskAct 2 'unclassifiable' 'the target window can no longer be classified; refusing'
  }
  if (Test-Denylisted $rw.Title $rw.ProcessName $Patterns) {
    return Deny-DeskAct 2 'denylisted' 'the target window is now denylisted; refusing'
  }

  $el = Find-DeskAutomationElement $handle $entry.RuntimeId
  if ($null -eq $el) {
    return Deny-DeskAct 2 'element-gone' "'$Ref' is no longer present in that window; re-run desk snapshot (no coordinate fallback, by design)"
  }
  return [pscustomobject]@{
    Code = 0; Reason = $null; Message = $null; Element = $el
    Window = [pscustomobject]@{ Handle = $handle; Title = $rw.Title; ProcessName = $rw.ProcessName }
  }
}

# Bring a window to the foreground and PROVE it took. Keystrokes go to whatever
# is foreground, so an unverified focus would type into the wrong window.
function Set-DeskForeground {
  param([IntPtr]$Handle)
  [void][DeskAct]::SetForegroundWindow($Handle)
  Start-Sleep -Milliseconds 150
  return ([DeskAct]::GetForegroundWindow() -eq $Handle)
}

function Invoke-DeskClick {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $el = $r.Element
  foreach ($try in @(
    @{ Name = 'Invoke';        Pattern = [System.Windows.Automation.InvokePattern]::Pattern;        Act = { param($p) $p.Invoke() } },
    @{ Name = 'Toggle';        Pattern = [System.Windows.Automation.TogglePattern]::Pattern;        Act = { param($p) $p.Toggle() } },
    @{ Name = 'SelectionItem'; Pattern = [System.Windows.Automation.SelectionItemPattern]::Pattern; Act = { param($p) $p.Select() } }
  )) {
    $pat = $null
    if ($el.TryGetCurrentPattern($try.Pattern, [ref]$pat)) {
      & $try.Act $pat
      return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
        Element = $null; Window = $r.Window; Detail = "pattern=$($try.Name)" }
    }
  }
  # No coordinate-click fallback: a control with no invokable pattern refuses.
  return Deny-DeskAct 2 'no-invokable-pattern' "'$Ref' exposes no Invoke/Toggle/SelectionItem pattern; refusing (deskclaw does not click coordinates)"
}

function Invoke-DeskType {
  param([string]$Ref, [string]$Text, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $el = $r.Element

  $vp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and
      -not $vp.Current.IsReadOnly) {
    $vp.SetValue($Text)
    return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
      Element = $null; Window = $r.Window; Detail = "pattern=Value;chars=$($Text.Length)" }
  }

  # Fallback is real keystrokes, which demand proven focus at both levels.
  if (-not (Set-DeskForeground $r.Window.Handle)) {
    return Deny-DeskAct 2 'focus-failed' 'could not bring the target window to the foreground; refusing to type'
  }
  try { $el.SetFocus() } catch {
    return Deny-DeskAct 2 'focus-failed' "could not focus '$Ref'; refusing to type"
  }
  Start-Sleep -Milliseconds 100
  if (-not $el.Current.HasKeyboardFocus) {
    return Deny-DeskAct 2 'focus-failed' "'$Ref' did not take keyboard focus; refusing to type"
  }
  [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysLiteral $Text))
  return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
    Element = $null; Window = $r.Window; Detail = "pattern=SendKeys;chars=$($Text.Length)" }
}

function Invoke-DeskKey {
  param($Window, [string]$Keys, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }
  if (-not (Set-DeskForeground $Window.Handle)) {
    return Deny-DeskAct 2 'focus-failed' 'could not bring the target window to the foreground; refusing to send keys'
  }
  # $Keys is raw SendKeys syntax on purpose: {ENTER}, ^s, %{F4} — documented.
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
    Element = $null; Window = $Window; Detail = "keys-len=$($Keys.Length)" }
}

function Invoke-DeskFocus {
  param($Window, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }
  if (-not (Set-DeskForeground $Window.Handle)) {
    return Deny-DeskAct 2 'focus-failed' 'could not bring the target window to the foreground'
  }
  return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
    Element = $null; Window = $Window; Detail = 'focused' }
}
