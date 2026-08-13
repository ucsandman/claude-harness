Set-StrictMode -Version Latest

function Get-DenyPattern {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return @() }
  return @(Get-Content -LiteralPath $Path |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Test-Denylisted {
  param([string]$Title, [string]$ProcessName, [string[]]$Patterns)
  $hay = "$Title $ProcessName".ToLowerInvariant()
  foreach ($p in $Patterns) {
    if ($p -and $hay.Contains($p.ToLowerInvariant())) { return $true }
  }
  return $false
}

function Protect-Secret {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $t = $Text
  # Specific shapes first; the generic hex rule runs last.
  $t = [regex]::Replace($t, '(?i)\b(?:sk|pk|rk)[-_][A-Za-z0-9_\-]{8,}', '[REDACTED]')
  $t = [regex]::Replace($t, '(?i)\bghp_[A-Za-z0-9]{8,}', '[REDACTED]')
  $t = [regex]::Replace($t, '(?i)\bxox[baprs]-[A-Za-z0-9\-]{8,}', '[REDACTED]')
  $t = [regex]::Replace($t, '\bAKIA[0-9A-Z]{12,}', '[REDACTED]')
  $t = [regex]::Replace($t, '(?i)\bBearer\s+[A-Za-z0-9\._\-]{10,}', 'Bearer [REDACTED]')
  $t = [regex]::Replace($t, '\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}', '[REDACTED]')
  $t = [regex]::Replace($t, '\b([A-Z][A-Z0-9_]{2,})=(\S{13,})', '$1=[REDACTED]')
  $t = [regex]::Replace($t, '\b[A-Fa-f0-9]{20,}\b', '[REDACTED]')
  return $t
}
