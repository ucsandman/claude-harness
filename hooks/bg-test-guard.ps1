# bg-test-guard.ps1 - PreToolUse [Bash]
# Blocks run_in_background for finite test/build commands (a backgrounded vitest run
# burned 300k tokens on a Monitor that never resolved, 2026-08-11; corpus shard_001).
# Long-lived watchers (dev/serve/watch/start) are dev-server-guard's territory, not ours.
# Override marker: BG_TEST_OK anywhere in the command.
$raw = [Console]::In.ReadToEnd()
try { $evt = $raw | ConvertFrom-Json } catch { exit 0 }
if ($evt.tool_name -ne 'Bash') { exit 0 }
$ti = $evt.tool_input
if (-not $ti -or $ti.run_in_background -ne $true) { exit 0 }
$cmd = [string]$ti.command
if ([string]::IsNullOrWhiteSpace($cmd) -or $cmd -match 'BG_TEST_OK') { exit 0 }
$finite = '(?i)\b(vitest|jest|pytest|playwright\s+test|cargo\s+test|go\s+test|tsc\b|next\s+build|npm\s+run\s+build|npm\s+test\b|npm\s+run\s+test\S*|npx\s+(vitest|jest|playwright))'
$watcher = '(?i)\b(dev\b|watch|serve\b|start\b|--watch)'
if ($cmd -match $finite -and $cmd -notmatch $watcher) {
  $logDir = Join-Path $env:USERPROFILE '.claude\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -Path (Join-Path $logDir 'bg-test-guard.log') -Value ("{0}`t{1}" -f (Get-Date -Format o), $cmd)
  $reason = 'bg-test-guard: finite test/build commands run FOREGROUND with an explicit timeout (a backgrounded test run burned 300k tokens waiting on a Monitor that never resolved). Re-run without run_in_background and set a timeout. Override marker if genuinely needed: BG_TEST_OK.'
  @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } | ConvertTo-Json -Depth 5 -Compress
}
exit 0
