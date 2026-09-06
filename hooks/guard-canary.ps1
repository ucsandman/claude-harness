# guard-canary.ps1 - SessionStart, throttled ~20h.
# L1 applied to the harness: actively make each guard fail on purpose and confirm it
# blocks. A guard whose failure mode is silence reads as "clean" (corpus F4: ~32
# silently skipped security reviews, a hook auditing in observe mode, a fully broken
# pre-commit chain under Git Bash). DashClaw-side liveness is covered by
# enforcement_liveness_probe.py; this checks harness guards only.
$ErrorActionPreference = 'Continue'
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$statusPath = Join-Path $claudeDir 'guard-canary-status.json'

$prev = $null
if (Test-Path $statusPath) {
  try { $prev = Get-Content $statusPath -Raw | ConvertFrom-Json } catch { $prev = $null }
}
if ($prev -and $prev.ok -and ([datetime]::UtcNow - [datetime]$prev.ranAt).TotalHours -lt 20) { exit 0 }

$results = [ordered]@{}

# 1. secret-guard must DENY a canary Stripe live key (pattern-based, entropy-independent)
$canaryKey = 'sk_live_' + ('a' * 24)
$payload = @{ tool_name = 'Write'; tool_input = @{ file_path = 'C:/temp/guard-canary.txt'; content = "STRIPE_KEY=$canaryKey" } } | ConvertTo-Json -Depth 5 -Compress
$out = $payload | node (Join-Path $claudeDir 'hooks\secret-guard.cjs') 2>&1 | Out-String
$results['secret-guard-denies-canary'] = [bool]($out -match '"permissionDecision"\s*:\s*"deny"')

# 2. agent-model-guard must DENY a model-less Agent spawn
$payload2 = @{ tool_name = 'Agent'; tool_input = @{ description = 'guard canary'; prompt = 'guard canary probe'; subagent_type = 'general-purpose' } } | ConvertTo-Json -Depth 5 -Compress
$out2 = $payload2 | node (Join-Path $claudeDir 'hooks\agent-model-guard.cjs') 2>&1 | Out-String
$results['model-guard-denies-modelless'] = [bool]($out2 -match '"permissionDecision"\s*:\s*"deny"')

# 2b. gate-freeze must DENY a hook edit from a project cwd, and the frozen fileset must match its lock
$payload3 = @{ tool_name = 'Edit'; cwd = 'C:/Projects/guard-canary-app'; tool_input = @{ file_path = (Join-Path $claudeDir 'hooks\rm-guard.cjs'); old_string = 'a'; new_string = 'b' } } | ConvertTo-Json -Depth 5 -Compress
$out3 = $payload3 | node (Join-Path $claudeDir 'hooks\gate-freeze.cjs') 2>&1 | Out-String
$results['gate-freeze-denies-project-edit'] = [bool]($out3 -match '"permissionDecision"\s*:\s*"deny"')
$freezeOut = & node (Join-Path $claudeDir 'tools\gates\gates.cjs') gate-freeze 2>&1 | Out-String
$results['frozen-guards-match-lock'] = ($LASTEXITCODE -eq 0)
if ($LASTEXITCODE -ne 0) { $missing += ($freezeOut -split "`n" | Where-Object { $_ -match 'CHANGED|ADDED|REMOVED|no lock' } | ForEach-Object { $_.Trim() }) }

# 3. git pre-commit chain is wired
$hp = git config --global core.hooksPath 2>$null
$results['hooksPath-set'] = [bool]($hp -match '\.claude[/\\]git-hooks')
$results['pre-commit-exists'] = Test-Path (Join-Path $claudeDir 'git-hooks\pre-commit')

# 4. every hook command registered in settings.json points at a file that exists
$missing = @()
try {
  $settings = Get-Content (Join-Path $claudeDir 'settings.json') -Raw | ConvertFrom-Json
  foreach ($ev in $settings.hooks.PSObject.Properties) {
    foreach ($entry in $ev.Value) {
      foreach ($h in $entry.hooks) {
        if ($h.command -match '"([^"]+\.(cjs|py|ps1))"') {
          $target = $Matches[1]
          if (-not (Test-Path $target)) { $missing += $target }
        }
      }
    }
  }
  $results['hook-targets-exist'] = ($missing.Count -eq 0)
} catch {
  $results['hook-targets-exist'] = $false
  $missing += "settings.json unreadable: $($_.Exception.Message)"
}

$ok = -not ($results.Values -contains $false)
[ordered]@{
  ranAt = [datetime]::UtcNow.ToString('o')
  ok = $ok
  results = $results
  missing = $missing
} | ConvertTo-Json -Depth 5 | Set-Content -Path $statusPath -Encoding utf8

if (-not $ok) {
  $failed = ($results.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key }) -join ', '
  Write-Output "GUARD CANARY FAILED: [$failed]. A safety guard is not enforcing right now. Fix this before trusting any guarded operation this session. Details: $statusPath"
  if (-not $results['frozen-guards-match-lock']) { Write-Output "A frozen guard file changed since the last lock (edited by hand, by Codex, or with the guard off). Review it, then from a harness session: node ~/.claude/tools/gates/gates.cjs --lock. Drift: $($missing -join '; ')" }
}
exit 0
