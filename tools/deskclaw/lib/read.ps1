Set-StrictMode -Version Latest

# Read side of stage 2. Nothing here is arm-gated: reading a property or the clipboard
# is not acting. STOP and the denylist still apply — those are read controls, not act
# controls — and every string that comes back goes through Protect-Secret first.

$script:DeskReadProps = @('value', 'name', 'text', 'toggle', 'selected', 'enabled')

function Read-DeskElementProperty {
  param([string]$Ref, [string]$Prop, [string[]]$Patterns, [string]$Root = (Get-DeskRoot))
  if (-not $Prop) { $Prop = 'value' }
  $Prop = $Prop.ToLowerInvariant()
  if ($Prop -notin $script:DeskReadProps) {
    return [pscustomobject]@{ Code = 1; Reason = 'bad-prop'
      Message = "unknown --prop '$Prop'; expected one of: $($script:DeskReadProps -join ', ')"; Text = $null }
  }
  if (Test-DeskStop $Root) {
    return [pscustomobject]@{ Code = 3; Reason = 'stop'
      Message = 'deskclaw is STOPPED (state/STOP present). Clear it in the viewer to resume.'; Text = $null }
  }
  $r = Resolve-DeskSnapshotElement $Ref $Patterns $Root
  if ($r.Code -ne 0) {
    return [pscustomobject]@{ Code = $r.Code; Reason = $r.Reason; Message = $r.Message; Text = $null }
  }
  $el = $r.Element

  if ($Prop -eq 'text') {
    return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null; Text = (Get-DeskElementText $el) }
  }
  if ($Prop -eq 'name') {
    $n = ''
    try { $n = [string]$el.Current.Name } catch { $n = '' }
    return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null; Text = (Protect-Secret $n) }
  }

  $a = Get-DeskElementAttribute $el
  $v = switch ($Prop) {
    'value'    { $a.Value }
    'toggle'   { $a.Toggle }
    'selected' { if ($a.Selected -eq $true) { 'true' } else { 'false' } }
    'enabled'  { if ($a.Enabled -eq $false) { 'false' } else { 'true' } }
  }
  if ($null -eq $v) {
    return [pscustomobject]@{ Code = 2; Reason = 'no-such-property'
      Message = "'$Ref' exposes no $Prop"; Text = $null }
  }
  return [pscustomobject]@{ Code = 0; Reason = $null; Message = $null; Text = [string]$v }
}

function Get-DeskClipboard {
  param([int]$Max = 4000)
  if (Test-DeskStop (Get-DeskRoot)) { throw "deskclaw is STOPPED (state/STOP present)." }
  $t = ''
  try { $t = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { $t = '' }
  if ($null -eq $t) { $t = '' }
  if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) }
  return (Protect-Secret $t)
}
