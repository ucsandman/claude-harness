# harness-health.ps1 — read-only Claude Code harness check. Changes nothing.
$ErrorActionPreference = 'SilentlyContinue'
$claude = "$env:USERPROFILE\.claude"
$issues = @()

# 1. Every hook command's script file exists
$settings = Get-Content "$claude\settings.json" -Raw | ConvertFrom-Json
$refd = @()
foreach ($event in $settings.hooks.PSObject.Properties) {
  foreach ($block in $event.Value) {
    foreach ($h in $block.hooks) {
      foreach ($m in [regex]::Matches($h.command, '"([^"]+\.(py|cjs|sh|ps1|mjs))"')) {
        $p = $m.Groups[1].Value -replace '/', '\'
        $refd += $p
        if (-not (Test-Path $p)) { $issues += "MISSING hook target: $p (event $($event.Name))" }
      }
    }
  }
}

# 2. Orphaned scripts in hooks\ that nothing references.
# Scripts can be wired two ways: a settings.json hook, or a Windows scheduled task
# (e.g. ClaudeLspReaper runs hooks\lsp-reaper.ps1 every 5 min). Collect both before
# calling anything an orphan — a false positive here trains you to ignore real ones.
$taskRefd = @()
foreach ($t in (Get-ScheduledTask)) {
  foreach ($a in $t.Actions) {
    $line = "$($a.Execute) $($a.Arguments)"
    foreach ($m in [regex]::Matches($line, '[A-Za-z]:\\[^"'']+\.(py|cjs|sh|ps1|mjs|vbs|cmd|bat)')) {
      $taskRefd += $m.Value -replace '/', '\'
    }
  }
}
# Follow one hop through launchers: a scheduled task may call a .vbs/.cmd shim that
# in turn invokes the real script (ClaudeLspReaper -> lsp-reaper-launcher.vbs -> lsp-reaper.ps1).
foreach ($shim in @($refd + $taskRefd | Sort-Object -Unique | Where-Object { $_ -match '\.(vbs|cmd|bat|sh)$' -and (Test-Path $_) })) {
  $body = Get-Content $shim -Raw
  foreach ($m in [regex]::Matches($body, '[A-Za-z]:\\[^"'']+\.(py|cjs|sh|ps1|mjs|vbs)')) {
    $taskRefd += $m.Value -replace '/', '\'
  }
}

Get-ChildItem "$claude\hooks" -File | Where-Object { $_.Name -notlike '.*' } | ForEach-Object {
  $f = $_.FullName
  if ($refd -notcontains $f -and $taskRefd -notcontains $f) {
    $issues += "ORPHANED hook script (no settings.json entry, no scheduled task): $($_.Name)"
  }
}

# 3. Enabled plugins with no cache directory
foreach ($p in $settings.enabledPlugins.PSObject.Properties | Where-Object Value) {
  $name = ($p.Name -split '@')[0]
  if (-not (Get-ChildItem "$claude\plugins\cache" -Directory -Recurse -Depth 1 | Where-Object Name -eq $name)) {
    $issues += "ENABLED plugin with no cache dir: $($p.Name)"
  }
}

# 4. Cruft counts
$bak = @(Get-Item "$claude\CLAUDE.md.bak*").Count
$warn = @(Get-ChildItem "$claude\security" -Filter 'security_warnings_state_*.json' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7)).Count
$backups = @(Get-ChildItem "$claude\backups" -File).Count
if ($bak -gt 0) { $issues += "$bak stale CLAUDE.md backups" }
if ($warn -gt 10) { $issues += "$warn security-warning state files older than 7 days (safe to prune)" }
if ($backups -gt 10) { $issues += "$backups files in backups\ (prune?)" }

"=== harness-health $(Get-Date -Format yyyy-MM-dd) ==="
$enabledCount = @($settings.enabledPlugins.PSObject.Properties | Where-Object Value).Count
$skillCount = @(Get-ChildItem "$claude\skills" -Directory).Count
$archivedCount = @(Get-ChildItem "$claude\skills-archive" -Directory).Count
"Hook targets checked: $($refd.Count) | Enabled plugins: $enabledCount | Skills: $skillCount (archived: $archivedCount)"
if ($issues) { "ISSUES:"; $issues | ForEach-Object { "  ! $_" } } else { "No issues found." }
exit 0
