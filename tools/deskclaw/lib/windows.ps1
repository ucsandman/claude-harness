Set-StrictMode -Version Latest

if (-not ('DeskWin' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DeskWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
}

function Get-DeskWindowClass {
  param([IntPtr]$Handle)
  $sb = New-Object Text.StringBuilder 256
  if ([DeskWin]::GetClassName($Handle, $sb, 256) -le 0) { return '' }
  return $sb.ToString()
}

# x,y,w,h for the display list. Distinct from shot.ps1's Get-DeskWindowRect (L,T,R,B),
# which the occlusion check needs; keeping both means windows.ps1 stays loadable on its
# own, which is how tests/run.ps1 sources it.
function Get-DeskWindowBox {
  param([IntPtr]$Handle)
  $r = New-Object DeskWin+RECT
  if (-not [DeskWin]::GetWindowRect($Handle, [ref]$r)) { return $null }
  return [pscustomobject]@{ X = $r.L; Y = $r.T; W = ($r.R - $r.L); H = ($r.B - $r.T) }
}

# Owned popups: menus, combo dropdowns and flyouts are separate top-level windows, so
# the child walk of a window never sees them. Same process, plus either owned by the
# target or carrying WS_POPUP. GW_OWNER = 4, GWL_STYLE = -16, WS_POPUP = 0x80000000
# (bit 31, so a negative style int is exactly "has WS_POPUP").
function Get-DeskOwnedPopup {
  param([IntPtr]$Handle)
  $ownerPid = 0
  [void][DeskWin]::GetWindowThreadProcessId($Handle, [ref]$ownerPid)
  if ($ownerPid -eq 0) { return @() }
  $out = New-Object Collections.Generic.List[object]
  foreach ($rw in Get-DeskRawWindow) {
    if ($rw.Handle -eq $Handle) { continue }
    if ($rw.Pid -ne $ownerPid) { continue }
    $owner = [DeskWin]::GetWindow($rw.Handle, 4)
    $style = [DeskWin]::GetWindowLong($rw.Handle, -16)
    if ($owner -ne $Handle -and ($style -band 0x80000000) -eq 0) { continue }
    $box = Get-DeskWindowBox $rw.Handle
    if ($null -eq $box -or $box.W -le 0 -or $box.H -le 0) { continue }
    $out.Add([pscustomobject]@{
      Handle = $rw.Handle; Title = (Protect-Secret $rw.Title)
      Class = (Get-DeskWindowClass $rw.Handle); X = $box.X; Y = $box.Y
    })
  }
  return $out.ToArray()
}

function Merge-UwpWindow {
  param([object[]]$Windows)
  if (-not $Windows) { return @() }
  $realTitles = @($Windows |
    Where-Object { $_.ProcessName -ne 'ApplicationFrameHost' } |
    ForEach-Object { $_.Title })
  return @($Windows | Where-Object {
    -not ($_.ProcessName -eq 'ApplicationFrameHost' -and $realTitles -contains $_.Title)
  })
}

# The single raw enumerator. Returns EVERY visible top-level window, including
# ones with an empty title — safety checks (occlusion) need to see those too;
# only the display list (Get-DeskWindow) drops them.
function Get-DeskRawWindow {
  $found = New-Object Collections.Generic.List[object]
  $cb = [DeskWin+EnumWindowsProc]{
    param($h, $l)
    if ([DeskWin]::IsWindowVisible($h)) {
      $sb = New-Object Text.StringBuilder 512
      [void][DeskWin]::GetWindowText($h, $sb, 512)
      $pid32 = 0
      [void][DeskWin]::GetWindowThreadProcessId($h, [ref]$pid32)
      $proc = try { (Get-Process -Id $pid32 -ErrorAction Stop).ProcessName } catch { 'unknown' }
      $found.Add([pscustomobject]@{
        Title = $sb.ToString(); ProcessName = $proc; Pid = $pid32; Handle = $h
      })
    }
    return $true
  }
  [void][DeskWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $found.ToArray()
}

function Get-DeskWindow {
  param([string[]]$Patterns)
  if (Test-DeskStop (Get-DeskRoot)) { throw "deskclaw is STOPPED (state/STOP present)." }

  $raw = @(Get-DeskRawWindow | Where-Object { $_.Title.Length -gt 0 })
  $found = Merge-UwpWindow $raw

  $fg = [DeskWin]::GetForegroundWindow()
  $out = New-Object Collections.Generic.List[object]
  $i = 0
  foreach ($w in $found) {
    $i++
    $denied = Test-Denylisted $w.Title $w.ProcessName $Patterns
    $box = Get-DeskWindowBox $w.Handle
    $out.Add([pscustomobject]@{
      Ref         = "@w$i"
      Title       = if ($denied) { '' } else { Protect-Secret $w.Title }
      ProcessName = $w.ProcessName
      Pid         = $w.Pid
      Handle      = $w.Handle
      Denied      = $denied
      Class       = Get-DeskWindowClass $w.Handle
      X           = if ($box) { $box.X } else { $null }
      Y           = if ($box) { $box.Y } else { $null }
      W           = if ($box) { $box.W } else { $null }
      H           = if ($box) { $box.H } else { $null }
      Focused     = ($w.Handle -eq $fg)
    })
  }
  return $out.ToArray()
}

# The 0.2 line is the prefix, unchanged; class, rect and focus are appended. A denied
# window still gets no detail at all — its geometry is as much of a leak as its title.
function Format-DeskWindow {
  param($Window)
  if ($Window.Denied) { return "$($Window.Ref) [SKIPPED: denylisted]" }
  $line = "$($Window.Ref) `"$($Window.Title)`" ($($Window.ProcessName), $($Window.Pid))"
  $class = Get-DeskField $Window 'Class'
  if ($class) { $line += " $class" }
  $x = Get-DeskField $Window 'X'
  $w = Get-DeskField $Window 'W'
  if ($null -ne $x -and $null -ne $w) {
    $line += " [$x,$(Get-DeskField $Window 'Y'),$w,$(Get-DeskField $Window 'H')]"
  }
  if (Get-DeskField $Window 'Focused') { $line += ' focused=true' }
  return $line
}

function Resolve-DeskTarget {
  param([string]$Target, [object[]]$Windows, [string]$Action)
  if ($Target -match '^@w\d+$') {
    $w = $Windows | Where-Object { $_.Ref -eq $Target } | Select-Object -First 1
    if ($null -eq $w) {
      return [pscustomobject]@{ Window = $null; Code = 2; Reason = 'not-found'; Message = "no window matched '$Target'" }
    }
    if ($w.Denied) {
      return [pscustomobject]@{ Window = $null; Code = 2; Reason = 'denylisted'; Message = "$($w.Ref) is denylisted; refusing to $Action it" }
    }
    return [pscustomobject]@{ Window = $w; Code = 0; Reason = $null; Message = $null }
  } elseif ($Target) {
    $w = $Windows | Where-Object { -not $_.Denied -and $_.Title -like "*$Target*" } | Select-Object -First 1
    if ($null -eq $w) {
      return [pscustomobject]@{ Window = $null; Code = 2; Reason = 'not-found'; Message = "no window matched '$Target'" }
    }
    return [pscustomobject]@{ Window = $w; Code = 0; Reason = $null; Message = $null }
  } else {
    return [pscustomobject]@{ Window = $null; Code = 2; Reason = 'not-found'; Message = "no window matched '$Target'" }
  }
}
