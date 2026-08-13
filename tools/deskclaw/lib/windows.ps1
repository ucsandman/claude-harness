Set-StrictMode -Version Latest

if (-not ('DeskWin' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DeskWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
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

  $out = New-Object Collections.Generic.List[object]
  $i = 0
  foreach ($w in $found) {
    $i++
    $denied = Test-Denylisted $w.Title $w.ProcessName $Patterns
    $out.Add([pscustomobject]@{
      Ref         = "@w$i"
      Title       = if ($denied) { '' } else { Protect-Secret $w.Title }
      ProcessName = $w.ProcessName
      Pid         = $w.Pid
      Handle      = $w.Handle
      Denied      = $denied
    })
  }
  return $out.ToArray()
}

function Format-DeskWindow {
  param($Window)
  if ($Window.Denied) { return "$($Window.Ref) [SKIPPED: denylisted]" }
  return "$($Window.Ref) `"$($Window.Title)`" ($($Window.ProcessName), $($Window.Pid))"
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
