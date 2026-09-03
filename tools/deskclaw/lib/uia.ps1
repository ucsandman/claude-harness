Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Get-SafeRect {
  param($Rect)
  if ($null -eq $Rect) { return $null }
  foreach ($v in @($Rect.X, $Rect.Y, $Rect.Width, $Rect.Height)) {
    if ([double]::IsInfinity($v) -or [double]::IsNaN($v)) { return $null }
  }
  return [pscustomobject]@{
    X = [int]$Rect.X; Y = [int]$Rect.Y; W = [int]$Rect.Width; H = [int]$Rect.Height
  }
}

# Attribute text is redacted and capped BEFORE it is stored, not at print time, so
# last-snapshot.json and the viewer that renders it never hold the raw string either.
# 200 chars is the cap the read side is specified against; newlines collapse so one
# element is always one line.
function ConvertTo-DeskAttrText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $t = Protect-Secret ($Text -replace '\s+', ' ')
  if ($t.Length -gt 200) { $t = $t.Substring(0, 200) }
  return $t
}

function ConvertTo-DeskJsonString {
  param([string]$Text)
  if ($null -eq $Text) { $Text = '' }
  $t = $Text.Replace('\', '\\').Replace('"', '\"')
  $t = $t.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return '"' + $t + '"'
}

# State an agent would otherwise need a screenshot to see. Every read is wrapped: a
# UIA element can die between the walk finding it and a pattern being queried, and one
# dead node must not take the whole tree down. A null attribute means "no news" and is
# never printed, so the line stays short.
function Get-DeskElementPattern {
  param($Node, $Pattern)
  $p = $null
  try {
    if ($Node.TryGetCurrentPattern($Pattern, [ref]$p)) { return $p }
  } catch { return $null }
  return $null
}

function Get-DeskElementAttribute {
  param($Node)
  $a = @{ Value = $null; Toggle = $null; Selected = $null; Enabled = $null; Expanded = $null; Offscreen = $null }

  # A password field is exactly the case where a value read is a leak, and UIA will
  # happily hand some of them over. Never ask.
  $isPassword = $true
  try { $isPassword = [bool]$Node.Current.IsPassword } catch { $isPassword = $true }
  if (-not $isPassword) {
    $text = ''
    $vp = Get-DeskElementPattern $Node ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp) {
      try { $text = [string]$vp.Current.Value } catch { $text = '' }
    } else {
      $tp = Get-DeskElementPattern $Node ([System.Windows.Automation.TextPattern]::Pattern)
      if ($null -ne $tp) { try { $text = [string]$tp.DocumentRange.GetText(400) } catch { $text = '' } }
    }
    $text = ConvertTo-DeskAttrText $text
    if ($text -ne '') { $a.Value = $text }
  }

  $gp = Get-DeskElementPattern $Node ([System.Windows.Automation.TogglePattern]::Pattern)
  if ($null -ne $gp) {
    $state = ''
    try { $state = [string]$gp.Current.ToggleState } catch { $state = '' }
    if ($state -eq 'On') { $a.Toggle = 'on' }
    elseif ($state -eq 'Off') { $a.Toggle = 'off' }
    elseif ($state -eq 'Indeterminate') { $a.Toggle = 'mixed' }
  }

  $sp = Get-DeskElementPattern $Node ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $sp) {
    $sel = $false
    try { $sel = [bool]$sp.Current.IsSelected } catch { $sel = $false }
    if ($sel) { $a.Selected = $true }
  }

  $ep = Get-DeskElementPattern $Node ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($null -ne $ep) {
    $state = ''
    try { $state = [string]$ep.Current.ExpandCollapseState } catch { $state = '' }
    if ($state -eq 'Expanded' -or $state -eq 'PartiallyExpanded') { $a.Expanded = $true }
    elseif ($state -eq 'Collapsed') { $a.Expanded = $false }
  }

  try { if (-not $Node.Current.IsEnabled) { $a.Enabled = $false } } catch { }
  try { if ($Node.Current.IsOffscreen) { $a.Offscreen = $true } } catch { }
  return $a
}

# The whole readable text of an element, for `desk read --prop text`. Longer cap than a
# snapshot attribute because the caller asked for exactly this one thing.
function Get-DeskElementText {
  param($Node, [int]$Max = 2000)
  $tp = Get-DeskElementPattern $Node ([System.Windows.Automation.TextPattern]::Pattern)
  if ($null -ne $tp) {
    $t = ''
    try { $t = [string]$tp.DocumentRange.GetText($Max) } catch { $t = '' }
    if ($t) { return (Protect-Secret $t) }
  }
  $vp = Get-DeskElementPattern $Node ([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $vp) {
    $v = ''
    try { $v = [string]$vp.Current.Value } catch { $v = '' }
    return (Protect-Secret $v)
  }
  $n = ''
  try { $n = [string]$Node.Current.Name } catch { $n = '' }
  return (Protect-Secret $n)
}

# indentation @eN Type "Name" [x,y] is the 0.2 grammar and stays byte-identical; every
# attribute is appended AFTER the coordinates, and only when it carries news. Optional
# fields go through Get-DeskField because callers hand us both live records and the
# minimal objects the tests build.
function Format-DeskElement {
  param($Element)
  $indent = '  ' * $Element.Depth
  $line = "$indent$($Element.Ref) $($Element.Type) `"$($Element.Name)`" [$($Element.X),$($Element.Y)]"
  $value = Get-DeskField $Element 'Value'
  if ($value) { $line += " value=$(ConvertTo-DeskJsonString $value)" }
  $toggle = Get-DeskField $Element 'Toggle'
  if ($toggle) { $line += " toggle=$toggle" }
  if ((Get-DeskField $Element 'Selected') -eq $true) { $line += ' selected=true' }
  if ((Get-DeskField $Element 'Enabled') -eq $false) { $line += ' enabled=false' }
  $expanded = Get-DeskField $Element 'Expanded'
  if ($null -ne $expanded) { $line += " expanded=$(([string]$expanded).ToLowerInvariant())" }
  if ((Get-DeskField $Element 'Offscreen') -eq $true) { $line += ' offscreen=true' }
  $popup = Get-DeskField $Element 'Popup'
  if ($null -ne $popup) { $line += " popup=$(ConvertTo-DeskJsonString $popup)" }
  return $line
}

function ConvertTo-DeskElementJson {
  param($Element)
  $o = [ordered]@{
    ref = $Element.Ref; depth = $Element.Depth; type = $Element.Type
    name = $Element.Name; x = $Element.X; y = $Element.Y
  }
  $value = Get-DeskField $Element 'Value'
  if ($value) { $o['value'] = $value }
  $toggle = Get-DeskField $Element 'Toggle'
  if ($toggle) { $o['toggle'] = $toggle }
  if ((Get-DeskField $Element 'Selected') -eq $true) { $o['selected'] = $true }
  if ((Get-DeskField $Element 'Enabled') -eq $false) { $o['enabled'] = $false }
  $expanded = Get-DeskField $Element 'Expanded'
  if ($null -ne $expanded) { $o['expanded'] = [bool]$expanded }
  if ((Get-DeskField $Element 'Offscreen') -eq $true) { $o['offscreen'] = $true }
  $popup = Get-DeskField $Element 'Popup'
  if ($null -ne $popup) { $o['popup'] = $popup }
  return $o
}

function New-DeskElementRecord {
  # $Popup is deliberately untyped: [string]$x = $null lands as '', and an empty string
  # is the legitimate title of an untitled context menu, so '' must stay distinguishable
  # from "this element is not a popup root".
  param($Node, [string]$Ref, [int]$Depth, $Rect, [IntPtr]$Handle, $Popup = $null)
  $c = $Node.Current
  $a = Get-DeskElementAttribute $Node
  $rid = try { ($Node.GetRuntimeId() -join '.') } catch { '' }
  return [pscustomobject]@{
    Ref       = $Ref
    Depth     = $Depth
    Type      = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
    Name      = Protect-Secret $c.Name
    X         = $Rect.X
    Y         = $Rect.Y
    RuntimeId = $rid
    Handle    = [int64]$Handle
    Value     = $a.Value
    Toggle    = $a.Toggle
    Selected  = $a.Selected
    Enabled   = $a.Enabled
    Expanded  = $a.Expanded
    Offscreen = $a.Offscreen
    Popup     = $Popup
  }
}

# Defined at script scope, not nested inside Get-DeskSnapshot, so the recursive
# call resolves predictably under Set-StrictMode.
function Expand-DeskElement {
  param($Node, [int]$Level, [int]$MaxDepth, $List, $Counter, $Skipped, [IntPtr]$Handle)
  if ($Level -gt $MaxDepth) { return }
  $kids = $Node.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) {
    $c = $k.Current
    # Offscreen elements are still skipped, exactly as in 0.2: act.ps1 re-resolves
    # against the same rule, so including them here would hand out refs that refuse.
    # They are counted instead, and the count is reported at the end of the walk.
    if ($c.IsOffscreen) { $Skipped.Value++; continue }
    $rect = Get-SafeRect $c.BoundingRectangle
    if ($null -eq $rect) { continue }
    $Counter.Value++
    $List.Add((New-DeskElementRecord $k "@e$($Counter.Value)" $Level $rect $Handle))
    Expand-DeskElement $k ($Level + 1) $MaxDepth $List $Counter $Skipped $Handle
  }
}

function Get-DeskSnapshot {
  param([IntPtr]$Handle, [int]$Depth = 6)
  if (Test-DeskStop (Get-DeskRoot)) { throw "deskclaw is STOPPED (state/STOP present)." }
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if ($null -eq $el) { return [pscustomobject]@{ Elements = @(); Count = 0; Offscreen = 0 } }
  $elements = New-Object Collections.Generic.List[object]
  $counter = [ref]0
  $skipped = [ref]0
  Expand-DeskElement $el 0 $Depth $elements $counter $skipped $Handle

  # Menus and combo dropdowns are top-level windows owned by the target, so the child
  # walk above cannot reach them. Their roots are appended AFTER the main tree, which
  # keeps every @eN the main window already had pointing at the same element.
  foreach ($p in Get-DeskOwnedPopup $Handle) {
    $pel = try { [System.Windows.Automation.AutomationElement]::FromHandle($p.Handle) } catch { $null }
    if ($null -eq $pel) { continue }
    $praw = try { $pel.Current.BoundingRectangle } catch { $null }
    $prect = Get-SafeRect $praw
    if ($null -eq $prect) { $prect = [pscustomobject]@{ X = $p.X; Y = $p.Y; W = 0; H = 0 } }
    $counter.Value++
    $elements.Add((New-DeskElementRecord $pel "@e$($counter.Value)" 0 $prect $p.Handle $p.Title))
    Expand-DeskElement $pel 1 $Depth $elements $counter $skipped $p.Handle
  }

  return [pscustomobject]@{ Elements = $elements.ToArray(); Count = $elements.Count; Offscreen = $skipped.Value }
}
