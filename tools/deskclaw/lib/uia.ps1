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

function Format-DeskElement {
  param($Element)
  $indent = '  ' * $Element.Depth
  return "$indent$($Element.Ref) $($Element.Type) `"$($Element.Name)`" [$($Element.X),$($Element.Y)]"
}

# Defined at script scope, not nested inside Get-DeskSnapshot, so the recursive
# call resolves predictably under Set-StrictMode.
function Expand-DeskElement {
  param($Node, [int]$Level, [int]$MaxDepth, $List, $Counter)
  if ($Level -gt $MaxDepth) { return }
  $kids = $Node.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($k in $kids) {
    $c = $k.Current
    if ($c.IsOffscreen) { continue }
    $rect = Get-SafeRect $c.BoundingRectangle
    if ($null -eq $rect) { continue }
    $Counter.Value++
    $rid = try { ($k.GetRuntimeId() -join '.') } catch { '' }
    $List.Add([pscustomobject]@{
      Ref       = "@e$($Counter.Value)"
      Depth     = $Level
      Type      = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
      Name      = Protect-Secret $c.Name
      X         = $rect.X
      Y         = $rect.Y
      RuntimeId = $rid
    })
    Expand-DeskElement $k ($Level + 1) $MaxDepth $List $Counter
  }
}

function Get-DeskSnapshot {
  param([IntPtr]$Handle, [int]$Depth = 6)
  if (Test-DeskStop (Get-DeskRoot)) { throw "deskclaw is STOPPED (state/STOP present)." }
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if ($null -eq $el) { return [pscustomobject]@{ Elements = @(); Count = 0 } }
  $elements = New-Object Collections.Generic.List[object]
  $counter = [ref]0
  Expand-DeskElement $el 0 $Depth $elements $counter
  return [pscustomobject]@{ Elements = $elements.ToArray(); Count = $elements.Count }
}
