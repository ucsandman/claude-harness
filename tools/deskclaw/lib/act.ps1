Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DeskAct' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskAct {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
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
  # A popup handle recorded at snapshot time is routinely dead by act time (the menu
  # closed); FromHandle throws rather than returning null for those.
  $rootEl = try { [System.Windows.Automation.AutomationElement]::FromHandle($Handle) } catch { $null }
  if ($null -eq $rootEl) { return $null }
  $rootRid = try { ($rootEl.GetRuntimeId() -join '.') } catch { '' }
  if ($rootRid -and $rootRid -eq $RuntimeId) { return $rootEl }
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
# cannot be proven refuses (Code 2); nothing degrades to coordinates. This half is
# deliberately NOT arm-gated: `desk read` resolves the same way and reading is not
# acting. Resolve-DeskActElement below is this plus the gate.
function Resolve-DeskSnapshotElement {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
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

  # Popup elements (menu items, dropdown rows) live in their own top-level window, so
  # the search starts from the handle recorded WITH the element. The denylist re-check
  # above still runs against the owning window: that is the one with an identity.
  $searchHandle = $handle
  $eh = Get-DeskField $entry 'Handle'
  if ($eh -and [int64]$eh -ne 0) { $searchHandle = [IntPtr][int64]$eh }

  $el = Find-DeskAutomationElement $searchHandle $entry.RuntimeId
  if ($null -eq $el) {
    return Deny-DeskAct 2 'element-gone' "'$Ref' is no longer present in that window; re-run desk snapshot (no coordinate fallback, by design)"
  }
  return [pscustomobject]@{
    Code = 0; Reason = $null; Message = $null; Element = $el
    Window = [pscustomobject]@{ Handle = $handle; Title = $rw.Title; ProcessName = $rw.ProcessName }
  }
}

function Resolve-DeskActElement {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }
  return Resolve-DeskSnapshotElement $Ref $Patterns $Root
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

function Confirm-DeskAct {
  param($Window, [string]$Detail)
  return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null
    Element = $null; Window = $Window; Detail = $Detail }
}

# Bring an element into view. ScrollItemPattern is the precise answer; a container
# ScrollPattern page-down is the fallback for lists that only expose the container.
function Invoke-DeskScroll {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $si = Get-DeskElementPattern $r.Element ([System.Windows.Automation.ScrollItemPattern]::Pattern)
  if ($null -ne $si) {
    $si.ScrollIntoView()
    return Confirm-DeskAct $r.Window 'pattern=ScrollItem'
  }
  $node = $r.Element
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($i = 0; $i -lt 7 -and $null -ne $node; $i++) {
    $sp = Get-DeskElementPattern $node ([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($null -ne $sp -and $sp.Current.VerticallyScrollable) {
      $sp.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount,
                 [System.Windows.Automation.ScrollAmount]::LargeIncrement)
      return Confirm-DeskAct $r.Window "pattern=Scroll;depth=$i"
    }
    $node = try { $walker.GetParent($node) } catch { $null }
  }
  return Deny-DeskAct 2 'no-scroll-pattern' "'$Ref' and its containers expose no ScrollItem/Scroll pattern; refusing"
}

function Invoke-DeskExpand {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $ep = Get-DeskElementPattern $r.Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($null -eq $ep) { return Deny-DeskAct 2 'no-expand-pattern' "'$Ref' exposes no ExpandCollapse pattern; refusing" }
  if ([string]$ep.Current.ExpandCollapseState -eq 'Expanded') { return Confirm-DeskAct $r.Window 'already=expanded' }
  $ep.Expand()
  return Confirm-DeskAct $r.Window 'pattern=ExpandCollapse;state=expanded'
}

function Invoke-DeskCollapse {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $ep = Get-DeskElementPattern $r.Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($null -eq $ep) { return Deny-DeskAct 2 'no-expand-pattern' "'$Ref' exposes no ExpandCollapse pattern; refusing" }
  if ([string]$ep.Current.ExpandCollapseState -eq 'Collapsed') { return Confirm-DeskAct $r.Window 'already=collapsed' }
  $ep.Collapse()
  return Confirm-DeskAct $r.Window 'pattern=ExpandCollapse;state=collapsed'
}

function Invoke-DeskSelect {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $sp = Get-DeskElementPattern $r.Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -eq $sp) { return Deny-DeskAct 2 'no-selection-pattern' "'$Ref' exposes no SelectionItem pattern; refusing" }
  if ($sp.Current.IsSelected) { return Confirm-DeskAct $r.Window 'already=selected' }
  $sp.Select()
  return Confirm-DeskAct $r.Window 'pattern=SelectionItem'
}

# A toggle asked for a state it is already in is a no-op, not an error: an agent that
# says "make sure this is on" must be able to run twice without flipping it off.
function Resolve-DeskToggleAction {
  param([string]$Current, [string]$Desired)
  if (-not $Desired) { return 'toggle' }
  $c = switch ($Current) { 'On' { 'on' } 'Off' { 'off' } default { 'mixed' } }
  if ($c -eq $Desired.ToLowerInvariant()) { return 'noop' }
  return 'toggle'
}

function Invoke-DeskToggle {
  param([string]$Ref, [string]$Desired, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  if ($Desired -and $Desired -notin @('on', 'off')) {
    return Deny-DeskAct 1 'bad-state' "toggle takes 'on' or 'off', got '$Desired'"
  }
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  $gp = Get-DeskElementPattern $r.Element ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($null -eq $gp) { return Deny-DeskAct 2 'no-toggle-pattern' "'$Ref' exposes no Toggle pattern; refusing" }
  if ((Resolve-DeskToggleAction ([string]$gp.Current.ToggleState) $Desired) -eq 'noop') {
    return Confirm-DeskAct $r.Window "already=$Desired"
  }
  # A tri-state checkbox cycles On -> Off -> Indeterminate, so reaching a named state
  # can take more than one press. Three is a full cycle; never loop unbounded.
  for ($i = 0; $i -lt 3; $i++) {
    $gp.Toggle()
    if (-not $Desired) { break }
    Start-Sleep -Milliseconds 60
    if ((Resolve-DeskToggleAction ([string]$gp.Current.ToggleState) $Desired) -eq 'noop') {
      return Confirm-DeskAct $r.Window "pattern=Toggle;state=$Desired"
    }
  }
  if ($Desired) { return Deny-DeskAct 2 'toggle-stuck' "'$Ref' would not settle on '$Desired'" }
  return Confirm-DeskAct $r.Window 'pattern=Toggle'
}

# The one place deskclaw touches a coordinate, and only because Windows has no
# "open the context menu of this element" pattern. It is still identity-first: the
# element is re-resolved live, its own rectangle supplies the point, the window must
# prove foreground, and Shift+F10 (no coordinate at all) is tried first when the
# element can take keyboard focus.
function Invoke-DeskContext {
  param([string]$Ref, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $r = Resolve-DeskActElement $Ref $Patterns $Root
  if ($r.Code -ne 0) { return $r }
  if (-not (Set-DeskForeground $r.Window.Handle)) {
    return Deny-DeskAct 2 'focus-failed' 'could not bring the target window to the foreground; refusing to right-click'
  }
  $raw = try { $r.Element.Current.BoundingRectangle } catch { $null }
  $rect = Get-SafeRect $raw
  if ($null -ne $rect -and $rect.W -gt 0 -and $rect.H -gt 0) {
    $cx = $rect.X + [int]($rect.W / 2)
    $cy = $rect.Y + [int]($rect.H / 2)
    $save = New-Object DeskAct+POINT
    [void][DeskAct]::GetCursorPos([ref]$save)
    [void][DeskAct]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 60
    [DeskAct]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)   # RIGHTDOWN
    [DeskAct]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)   # RIGHTUP
    Start-Sleep -Milliseconds 120
    [void][DeskAct]::SetCursorPos($save.X, $save.Y)
    return Confirm-DeskAct $r.Window "method=right-click;at=$cx,$cy"
  }
  try { $r.Element.SetFocus() } catch {
    return Deny-DeskAct 2 'no-context-route' "'$Ref' has no usable rectangle and will not take focus; refusing"
  }
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait('+{F10}')
  return Confirm-DeskAct $r.Window 'method=shift-f10'
}

# Escape to whatever is foreground, to close a menu or dialog the agent just opened.
# The foreground window is classified first: a stray keystroke into a password manager
# is exactly what the denylist exists to prevent.
function Invoke-DeskDismiss {
  param([string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }
  $fg = [DeskAct]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return Deny-DeskAct 2 'no-foreground' 'no foreground window to dismiss' }
  $rw = @(Get-DeskRawWindow) | Where-Object { $_.Handle -eq $fg } | Select-Object -First 1
  if ($null -eq $rw) { return Deny-DeskAct 2 'unclassifiable' 'the foreground window cannot be classified; refusing' }
  if (Test-Denylisted $rw.Title $rw.ProcessName $Patterns) {
    return Deny-DeskAct 2 'denylisted' 'the foreground window is denylisted; refusing to send keys to it'
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  return Confirm-DeskAct ([pscustomobject]@{ Handle = $fg; Title = $rw.Title; ProcessName = $rw.ProcessName }) 'keys=ESC'
}

function Set-DeskClipboard {
  param([string]$Text, [string]$Root = (Get-DeskRoot))
  $gate = Test-DeskActGate $Root
  if ($gate) { return $gate }
  Set-Clipboard -Value $Text
  return Confirm-DeskAct $null "chars=$($Text.Length)"
}
