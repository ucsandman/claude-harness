# harness-health.ps1 - read-only Claude Code harness check. Changes nothing
# except its own state file (harness-health.state.json, next to this script).
#
# Scans EVERY settings layer Claude Code merges (highest precedence last):
#   ~/.claude/settings.json            user, global
#   ~/.claude/settings.local.json      user, global, untracked
#   <project>/.claude/settings.json    per project, shared
#   <project>/.claude/settings.local.json  per project, untracked
# Projects come from the `projects` map in ~/.claude.json (real paths), so a
# settings file that /config wrote into some repo is caught even if you never
# open that repo again.
#
# Switches:
#   -Probe      also execute every distinct hook command once with {} on stdin
#               (10s cap) and report the ones that blow up. Off by default:
#               a plain run never executes anything.
#   -IfChanged  exit immediately unless some settings*.json is newer than the
#               state file. Lets a SessionStart hook call this on every session
#               for almost no cost.
param(
  [switch]$Probe,
  [switch]$IfChanged
)
$ErrorActionPreference = 'SilentlyContinue'
$claude = "$env:USERPROFILE\.claude"
$statePath = "$claude\scripts\harness-health.state.json"
$issues = @()
$notes  = @()

# ---- 0. Enumerate settings files -------------------------------------------
$layers = @()
$layers += [pscustomobject]@{ Path = "$claude\settings.json";       Scope = 'user'; ProjDir = $env:USERPROFILE }
$layers += [pscustomobject]@{ Path = "$claude\settings.local.json"; Scope = 'user-local'; ProjDir = $env:USERPROFILE }
# -AsHashtable is required: ~/.claude.json holds case-colliding project keys
# (C:/Projects/L and C:/Projects/l) and plain ConvertFrom-Json refuses the file.
$projectPaths = @()
$projectMap = @{}
try {
  $root = Get-Content "$env:USERPROFILE\.claude.json" -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($root.projects) { $projectPaths = @($root.projects.Keys); $projectMap = $root.projects }
} catch { $issues += "Could not read ~/.claude.json project map ($($_.Exception.Message)) - project-level settings NOT scanned" }
$seenDirs = @{}
$projectDirs = @()
foreach ($p in $projectPaths) {
  $dir = ($p -replace '/', '\').TrimEnd('\')
  # ~/.claude.json keeps case variants of the same repo (C:/Projects/DashClaw vs
  # C:/projects/dashclaw); NTFS is case-insensitive, so scan each directory once.
  if ($seenDirs.ContainsKey($dir.ToLower())) { continue }
  $seenDirs[$dir.ToLower()] = $true
  $projectDirs += $dir
  foreach ($f in 'settings.json', 'settings.local.json') {
    $candidate = Join-Path (Join-Path $dir '.claude') $f
    if (Test-Path $candidate) {
      $layers += [pscustomobject]@{ Path = $candidate; Scope = "project ($dir)"; ProjDir = $dir }
    }
  }
}
$layers = $layers | Where-Object { Test-Path $_.Path }

# -IfChanged: nothing under any settings layer moved since the last run, so the
# last run's verdict still holds. Cheapest possible no-op for a SessionStart hook.
if ($IfChanged) {
  $stateStamp = (Get-Item $statePath).LastWriteTime
  if ($stateStamp) {
    $newer = @($layers | Where-Object { (Get-Item $_.Path).LastWriteTime -gt $stateStamp })
    if (-not $newer.Count) { exit 0 }
  }
}

# ---- 1. Parse every layer, check hook targets, surface overrides -----------
$refd = @()
$hookRefs = @()     # one record per resolved script path, for duplicate detection
$hookCmds = @()     # one record per hook command, for -Probe
$settings = $null   # the global user settings object, used by sections 4/5
$overrideKeys = 'outputStyle', 'model', 'effortLevel', 'permissions', 'env', 'disableAllHooks', 'enabledPlugins', 'hooks'
foreach ($layer in $layers) {
  $cfg = $null
  try { $cfg = Get-Content $layer.Path -Raw | ConvertFrom-Json -ErrorAction Stop } catch {
    $issues += "MALFORMED settings (ConvertFrom-Json failed - check for case-colliding keys): $($layer.Path)"
    continue
  }
  if ($layer.Scope -eq 'user') { $settings = $cfg }

  if ($cfg.disableAllHooks -eq $true) {
    $issues += "disableAllHooks=true in $($layer.Path) - every hook (guards included) is switched off for that scope"
  }

  foreach ($event in $cfg.hooks.PSObject.Properties) {
    foreach ($block in $event.Value) {
      foreach ($h in $block.hooks) {
        if ($h.command) {
          # cmd.exe cannot expand the harness' own $CLAUDE_PROJECT_DIR/$HOME, so
          # bake them in now - otherwise every such hook "fails" the probe.
          $expanded = ([string]$h.command).Replace('${CLAUDE_PROJECT_DIR}', $layer.ProjDir).Replace('$CLAUDE_PROJECT_DIR', $layer.ProjDir).Replace('$HOME', $env:USERPROFILE).Replace('$env:USERPROFILE', $env:USERPROFILE)
          $hookCmds += [pscustomobject]@{ Command = $expanded; Event = $event.Name; Layer = $layer.Path; ProjDir = $layer.ProjDir }
        }
        foreach ($m in [regex]::Matches($h.command, '"([^"]+\.(py|cjs|sh|ps1|mjs))"')) {
          $target = $m.Groups[1].Value -replace '/', '\'
          # Hook commands may use Claude Code's own variables; resolve them the way
          # the harness does before deciding the file is missing.
          if ($layer.Scope -like 'project (*') {
            $projDir = $layer.Scope.Substring(9).TrimEnd(')')
            $target = $target.Replace('$CLAUDE_PROJECT_DIR', $projDir)
          }
          $target = $target.Replace('$HOME', $env:USERPROFILE).Replace('$env:USERPROFILE', $env:USERPROFILE)
          if ($target.StartsWith('~')) { $target = $env:USERPROFILE + $target.Substring(1) }
          $refd += $target
          $hookRefs += [pscustomobject]@{ Target = $target; Event = $event.Name; Layer = $layer.Path; Scope = $layer.Scope; ProjDir = $layer.ProjDir }
          if (-not (Test-Path $target)) {
            $issues += "MISSING hook target: $target (event $($event.Name), in $($layer.Path))"
          }
        }
      }
    }
  }

  # Anything below the user layer overrides or extends it - say so, so a stray
  # /config write in one repo never silently wins over the global file.
  if ($layer.Scope -ne 'user') {
    $present = @()
    foreach ($k in $overrideKeys) {
      $v = $cfg.PSObject.Properties[$k]
      if ($null -eq $v) { continue }
      switch ($k) {
        'hooks'       { $present += "hooks[" + (($v.Value.PSObject.Properties.Name) -join ',') + "]" }
        'permissions' { $present += "permissions(allow=" + @($v.Value.allow).Count + ",deny=" + @($v.Value.deny).Count + ")" }
        'env'         { $present += "env[" + (($v.Value.PSObject.Properties.Name) -join ',') + "]" }
        'enabledPlugins' { $present += "enabledPlugins(" + @($v.Value.PSObject.Properties).Count + ")" }
        default       { $present += "$k=$($v.Value)" }
      }
    }
    if ($present.Count) { $notes += "$($layer.Scope) layer $($layer.Path): $($present -join ' | ')" }
  }
}
if (-not $settings) { $issues += "MISSING or unreadable global settings: $claude\settings.json" }

# ---- 2. Duplicate hooks across layers --------------------------------------
# The same script under the same event in two layers that BOTH apply runs twice
# per tool call. Two different projects never apply together, so only pairs that
# can co-fire count: any user layer with anything, or two layers of one project.
$dupSeen = @{}
foreach ($g in ($hookRefs | Group-Object { "$($_.Event)|$($_.Target.ToLower())" })) {
  if ($g.Count -lt 2) { continue }
  $recs = @($g.Group | Sort-Object Layer -Unique)
  for ($i = 0; $i -lt $recs.Count; $i++) {
    for ($j = $i + 1; $j -lt $recs.Count; $j++) {
      $a = $recs[$i]; $b = $recs[$j]
      $coFires = ($a.Scope -like 'user*') -or ($b.Scope -like 'user*') -or ($a.ProjDir -eq $b.ProjDir)
      if (-not $coFires) { continue }
      $key = "$($g.Name)|$($a.Layer)|$($b.Layer)".ToLower()
      if ($dupSeen.ContainsKey($key)) { continue }
      $dupSeen[$key] = $true
      $issues += "DUPLICATE hook: $($a.Target) ($($a.Event)) in $($a.Layer) and $($b.Layer)"
    }
  }
}

# ---- 3. MCP servers: does every stdio command actually resolve? -------------
# Sources: the per-project entries in ~/.claude.json, every project root's
# .mcp.json, and ~/.claude/.mcp.json. http/sse servers are counted only - this
# script never touches the network.
$mcpStdio = 0; $mcpRemote = 0; $untrusted = @()
function Test-McpCommand($cmd) {
  if (-not $cmd) { return $false }
  $c = [string]$cmd
  $c = $c.Replace('$HOME', $env:USERPROFILE).Replace('$env:USERPROFILE', $env:USERPROFILE).Replace('${HOME}', $env:USERPROFILE)
  if ($c.StartsWith('~')) { $c = $env:USERPROFILE + $c.Substring(1) }
  $c = [Environment]::ExpandEnvironmentVariables($c).Trim('"')
  if ($c -match '^[A-Za-z]:[\\/]' -or $c.StartsWith('\\')) {
    foreach ($ext in '', '.exe', '.cmd', '.bat', '.ps1') { if (Test-Path ($c + $ext)) { return $true } }
    return $false
  }
  return [bool](Get-Command $c -ErrorAction SilentlyContinue)
}
function Test-McpServers($servers, $file) {
  foreach ($name in @($servers.Keys)) {
    $s = $servers[$name]
    $type = [string]$s.type
    if ($type -eq 'http' -or $type -eq 'sse' -or ((-not $type) -and $s.url -and -not $s.command)) {
      $script:mcpRemote++
      continue
    }
    $script:mcpStdio++
    if (-not (Test-McpCommand $s.command)) {
      $script:issues += "MISSING MCP command: $name ($file)" + $(if ($s.command) { " -> $($s.command)" } else { " -> no command field" })
    }
  }
}
foreach ($key in $projectPaths) {
  $entry = $projectMap[$key]
  if ($null -eq $entry) { continue }
  if ($entry.mcpServers -and @($entry.mcpServers.Keys).Count) {
    Test-McpServers $entry.mcpServers "~/.claude.json project $key"
  }
  if ($entry.hasTrustDialogAccepted -eq $false -and (@($entry.allowedTools).Count -or @($entry.mcpServers.Keys).Count)) {
    $untrusted += $key
  }
}
foreach ($dir in (@($claude) + $projectDirs)) {
  $mcpFile = Join-Path $dir '.mcp.json'
  if (-not (Test-Path $mcpFile)) { continue }
  try {
    $mcp = Get-Content $mcpFile -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  } catch {
    $issues += "MALFORMED .mcp.json (ConvertFrom-Json failed): $mcpFile"
    continue
  }
  if ($mcp.mcpServers) { Test-McpServers $mcp.mcpServers $mcpFile }
}
if ($untrusted.Count) {
  $notes += "$($untrusted.Count) project(s) carry allowedTools/mcpServers but hasTrustDialogAccepted=false: " + (($untrusted | Select-Object -First 5) -join ', ')
}

# ---- 4. Orphaned scripts in hooks\ that nothing references -----------------
# Scripts can be wired two ways: any settings layer's hook, or a Windows scheduled
# task (e.g. ClaudeLspReaper runs hooks\lsp-reaper.ps1 every 5 min). Collect both
# before calling anything an orphan - a false positive here trains you to ignore
# real ones.
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
    $issues += "ORPHANED hook script (no settings entry in any layer, no scheduled task): $($_.Name)"
  }
}

# ---- 5. Enabled plugins with no cache directory ----------------------------
foreach ($p in $settings.enabledPlugins.PSObject.Properties | Where-Object Value) {
  $name = ($p.Name -split '@')[0]
  if (-not (Get-ChildItem "$claude\plugins\cache" -Directory -Recurse -Depth 1 | Where-Object Name -eq $name)) {
    $issues += "ENABLED plugin with no cache dir: $($p.Name)"
  }
}

# ---- 6. Cruft counts --------------------------------------------------------
$bak = @(Get-Item "$claude\CLAUDE.md.bak*").Count
$warn = @(Get-ChildItem "$claude\security" -Filter 'security_warnings_state_*.json' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7)).Count
$backups = @(Get-ChildItem "$claude\backups" -File).Count
if ($bak -gt 0) { $issues += "$bak stale CLAUDE.md backups" }
if ($warn -gt 10) { $issues += "$warn security-warning state files older than 7 days (safe to prune)" }
if ($backups -gt 10) { $issues += "$backups files in backups\ (prune?)" }

# ---- 7. -Probe: dry-run every distinct hook command -------------------------
# Feeds each command an empty JSON object on stdin, the way the harness would,
# with CLAUDE_PROJECT_DIR set to the layer's project. Exit 2 is a hook DENY and
# perfectly healthy; anything else non-zero means the hook is broken.
$probeIssues = @()
$probeStats = $null
function Invoke-HookProbe($cmd, $projDir) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/s /c "' + $cmd + '"'          # /s: strip the outer quotes, run the rest verbatim
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $projDir
  $psi.Environment['CLAUDE_PROJECT_DIR'] = $projDir
  $p = [System.Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  try { $p.StandardInput.Write('{}'); $p.StandardInput.Close() } catch { }
  if (-not $p.WaitForExit(10000)) {
    try { $p.Kill($true) } catch { }
    return [pscustomobject]@{ Exit = -1; Err = 'timed out after 10s'; TimedOut = $true }
  }
  $err = ''
  try { $err = ($errTask.Result + "`n" + $outTask.Result) } catch { }
  $first = @($err -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)[0]
  if ($first -and $first.Length -gt 140) { $first = $first.Substring(0, 140) + '...' }
  return [pscustomobject]@{ Exit = $p.ExitCode; Err = $first; TimedOut = $false }
}
if ($Probe) {
  $pass = 0; $deny = 0; $fail = 0
  foreach ($g in ($hookCmds | Group-Object Command)) {
    $rec = $g.Group[0]
    $r = Invoke-HookProbe $rec.Command $rec.ProjDir
    if ($r.Exit -eq 0) { $pass++ }
    elseif ($r.Exit -eq 2) { $deny++ }
    else {
      $fail++
      $probeIssues += "PROBE FAIL: $($rec.Command) exit $($r.Exit) $($r.Err)"
    }
  }
  $probeStats = "Hooks probed: $(@($hookCmds | Group-Object Command).Count) | pass: $pass | deny(2): $deny | fail: $fail"
}

# ---- 8. Report --------------------------------------------------------------
"=== harness-health $(Get-Date -Format yyyy-MM-dd) ==="
$enabledCount = @($settings.enabledPlugins.PSObject.Properties | Where-Object Value).Count
$skillCount = @(Get-ChildItem "$claude\skills" -Directory).Count
$archivedCount = @(Get-ChildItem "$claude\skills-archive" -Directory).Count
$projLayers = @($layers | Where-Object { $_.Scope -like 'project*' }).Count
"Settings layers scanned: $(@($layers).Count) (user + user-local + $projLayers project files across $($projectPaths.Count) known projects)"
"Hook targets checked: $($refd.Count) | Enabled plugins: $enabledCount | Skills: $skillCount (archived: $archivedCount)"
"MCP servers: $mcpStdio stdio checked | $mcpRemote http/sse (not contacted)"
if ($probeStats) { $probeStats } else { "Hook probe: skipped (pass -Probe to execute each hook once with {} on stdin)" }
if ($notes) { "OVERRIDES (layers that shadow or extend ~/.claude/settings.json):"; $notes | ForEach-Object { "  - $_" } }
$allIssues = @($issues) + @($probeIssues)
if ($allIssues.Count) { "ISSUES:"; $allIssues | ForEach-Object { "  ! $_" } } else { "No issues found." }

# ---- 9. Diff against the last run (the only thing this script writes) -------
$prev = $null
if (Test-Path $statePath) {
  try { $prev = Get-Content $statePath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $prev = $null }
}
# A run without -Probe knows nothing about probe issues, so it carries the last
# probe verdict forward instead of reporting every PROBE FAIL as resolved.
$stateProbe = if ($Probe) { @($probeIssues) } else { @($prev.probeIssues) }
if ($null -eq $prev) {
  "Baseline recorded ($($allIssues.Count) issue(s)) - no diff on a first run."
} else {
  $before = @($prev.issues) + @($prev.probeIssues) | Where-Object { $_ }
  $after  = @($issues) + @($stateProbe) | Where-Object { $_ }
  $new      = @($after  | Where-Object { $before -notcontains $_ })
  $resolved = @($before | Where-Object { $after  -notcontains $_ })
  "Diff vs $($prev.timestamp): $($new.Count) new, $($resolved.Count) resolved."
  if ($new.Count)      { "NEW SINCE LAST RUN:";  $new      | ForEach-Object { "  + $_" } }
  if ($resolved.Count) { "RESOLVED:";            $resolved | ForEach-Object { "  - $_" } }
}
$state = [pscustomobject]@{
  timestamp   = (Get-Date -Format 's')
  probed      = [bool]$Probe
  issues      = @($issues)
  probeIssues = @($stateProbe | Where-Object { $_ })
}
try { $state | ConvertTo-Json -Depth 4 | Set-Content $statePath -Encoding utf8 -ErrorAction Stop } catch {
  "  ! could not write state file $statePath ($($_.Exception.Message))"
}
exit 0
