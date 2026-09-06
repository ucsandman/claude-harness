# agent-reaper.ps1 - kills orphaned agent processes and stale headless runs.
#
# Sibling of lsp-reaper.ps1 (same rules, wider net). The LSP reaper only
# watches tsserver; nothing watched the agents themselves. A Workflow that
# fans out 50 subagents, a headless `claude -p` launched by a scheduled task,
# or an MCP server spawned by a session all outlive their parent when that
# parent dies hard (terminal closed, harness crash, task killed). Each one
# then idles forever holding memory and, for MCP servers, a port or a browser.
#
#   RULE 1 (orphans): any process in the MATCHED SET whose parent is dead is
#     killed together with its descendants. Healthy instances always have a
#     live parent: the terminal, the parent claude session, or the MCP host.
#   RULE 2 (stale headless): a headless claude run (`-p` / `--print`) older
#     than $MaxHeadlessHours is killed with its descendants. Interactive
#     sessions are never age-capped.
#   RULE 3 (fleet cap): more than $Cap live claude.exe processes is logged as
#     a warning only. A large fan-out can be legitimate; the agent-model-guard
#     hook is the place that blocks it before it starts.
#
# MATCHED SET: claude.exe, plus node/python/pwsh processes whose command line
#   looks like harness plumbing (an MCP server, an `npx -y @scope/pkg`
#   launcher, anything under ~/.claude or the clawd tools dir). A user's own
#   node dev server never matches, so it is never touched even when orphaned.
#
# Usage:
#   powershell -File agent-reaper.ps1            # act, log to ~\.claude\logs\agent-reaper.log
#   powershell -File agent-reaper.ps1 -DryRun    # print what would be killed, kill nothing
# Scheduled task: ClaudeAgentReaper (every 10 min) via agent-reaper-launcher.vbs.
#   Remove with: Unregister-ScheduledTask -TaskName ClaudeAgentReaper -Confirm:$false

param(
    [switch]$DryRun,
    [int]$MaxHeadlessHours = 12,
    [int]$Cap = 24
)

$log = Join-Path $env:USERPROFILE '.claude\logs\agent-reaper.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    if ($DryRun) { Write-Output $line } else { Add-Content -Path $log -Value $line }
}

function Short([string]$s) {
    if (-not $s) { return '' }
    return $s.Substring(0, [Math]::Min(120, $s.Length))
}

# One snapshot of every process; every decision below reads from it.
$all = @{}
foreach ($p in Get-CimInstance Win32_Process) { $all[[int]$p.ProcessId] = $p }

$plumbingRe = '(?i)mcp|[\\/]\.claude[\\/]|[\\/]clawd[\\/]tools[\\/]|npx-cli\.js.*-y\s+@|declick'
$matched = @($all.Values | Where-Object {
    ($_.Name -eq 'claude.exe') -or
    (($_.Name -match '^(node|python|pwsh|powershell)\.exe$') -and ($_.CommandLine -match $plumbingRe))
})

if (-not $matched) { if ($DryRun) { Write-Output 'agent-reaper: matched=0' }; exit 0 }

function Is-Orphan($p) {
    $parent = $all[[int]$p.ParentProcessId]
    # PID-reuse guard: a real parent must predate its child.
    return (-not $parent) -or ($parent.CreationDate -gt $p.CreationDate)
}

function Descendants([int]$root) {
    $out = @()
    foreach ($c in $all.Values) {
        if ([int]$c.ParentProcessId -eq $root -and $c.CreationDate -ge $all[$root].CreationDate) {
            $out += $c
            $out += Descendants([int]$c.ProcessId)
        }
    }
    return $out
}

$victims = @{}   # pid -> reason
foreach ($p in $matched) {
    $pid_ = [int]$p.ProcessId
    if ($pid_ -eq $PID) { continue }
    if (Is-Orphan $p) {
        $victims[$pid_] = "orphan ppid=$($p.ParentProcessId)"
        foreach ($d in (Descendants $pid_)) { if (-not $victims.ContainsKey([int]$d.ProcessId)) { $victims[[int]$d.ProcessId] = "child-of-orphan $pid_" } }
        continue
    }
    if ($p.Name -eq 'claude.exe' -and $p.CommandLine -match '(\s-p\s|\s--print(\s|$))') {
        $ageH = ((Get-Date) - $p.CreationDate).TotalHours
        if ($ageH -gt $MaxHeadlessHours) {
            $victims[$pid_] = ("stale-headless age={0:N1}h cap={1}h" -f $ageH, $MaxHeadlessHours)
            foreach ($d in (Descendants $pid_)) { if (-not $victims.ContainsKey([int]$d.ProcessId)) { $victims[[int]$d.ProcessId] = "child-of-stale $pid_" } }
        }
    }
}

$killed = 0
foreach ($pid_ in $victims.Keys) {
    $p = $all[$pid_]
    $reason = $victims[$pid_]
    if ($DryRun) {
        Write-Log ("WOULD KILL pid={0} {1} {2}  cmd={3}" -f $pid_, $p.Name, $reason, (Short $p.CommandLine))
        continue
    }
    try {
        # StartTime guard against PID reuse between snapshot and kill.
        $live = Get-Process -Id $pid_ -ErrorAction Stop
        if ([Math]::Abs(($live.StartTime - $p.CreationDate).TotalSeconds) -gt 2) { continue }
        Stop-Process -Id $pid_ -Force -ErrorAction Stop
        $killed++
        Write-Log ("killed pid={0} {1} {2}  cmd={3}" -f $pid_, $p.Name, $reason, (Short $p.CommandLine))
    } catch {}
}

$claudeCount = @($matched | Where-Object { $_.Name -eq 'claude.exe' }).Count
if ($claudeCount -gt $Cap) { Write-Log ("WARN {0} claude.exe processes live (cap={1}); not killing, check agent-model-guard" -f $claudeCount, $Cap) }

$summary = "reaped {0} of matched={1} (claude={2}, victims={3})" -f $killed, $matched.Count, $claudeCount, $victims.Count
if ($DryRun) { Write-Output ("agent-reaper: " + $summary) } elseif ($killed -gt 0) { Write-Log $summary }
exit 0
