Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

if (-not ('DeskShot' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
}

function Save-DeskShot {
  param([IntPtr]$Handle, [string]$OutPath)
  if (Test-DeskStop (Get-DeskRoot)) { throw "deskclaw is STOPPED (state/STOP present)." }
  $r = New-Object DeskShot+RECT
  if (-not [DeskShot]::GetWindowRect($Handle, [ref]$r)) {
    throw "GetWindowRect failed for handle $Handle"
  }
  $w = $r.R - $r.L
  $h = $r.B - $r.T
  if ($w -le 0 -or $h -le 0) { throw "window has no visible area ($w x $h)" }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose(); $bmp.Dispose()
  }
  return [pscustomobject]@{
    Path  = $OutPath
    Bytes = (Get-Item -LiteralPath $OutPath).Length
  }
}

function Test-RectOverlap {
  param($A, $B)
  if ($A.L -le -30000 -or $A.T -le -30000) { return $false }
  if ($B.L -le -30000 -or $B.T -le -30000) { return $false }
  if ($A.R -le $B.L -or $B.R -le $A.L -or $A.B -le $B.T -or $B.B -le $A.T) { return $false }
  return $true
}

function Get-DeskWindowRect {
  param([IntPtr]$Handle)
  $r = New-Object DeskShot+RECT
  if (-not [DeskShot]::GetWindowRect($Handle, [ref]$r)) { return $null }
  return [pscustomobject]@{ L = $r.L; T = $r.T; R = $r.R; B = $r.B }
}
