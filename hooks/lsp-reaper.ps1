# lsp-reaper.ps1 - kills orphaned / runaway TypeScript LSP processes.
#
# Incident 2026-07-30: ~663 idle tsserver.js processes (~13.6 GB) accumulated
# from unreaped language-server spawns and nearly exhausted RAM. The spawner
# is harness-internal (not patchable here), so this watchdog guarantees the
# accumulation can never recur:
#   RULE 1 (orphans): any typescript-language-server / tsserver.js /
#     typingsInstaller.js node process whose parent is dead is killed.
#     (Healthy instances always have a live parent: the editor/agent session.)
#   RULE 2 (cap): if more than $Cap live-parent LSP processes exist from the
#     global npm install (Roaming\npm), the oldest beyond the cap are killed.
#     VS Code's bundled tsserver lives elsewhere and is never capped.
# Actions are appended to ~\.claude\logs\lsp-reaper.log.
# Scheduled task: ClaudeLspReaper (every 5 min), launched via
# lsp-reaper-launcher.vbs (wscript spawns no console window). Remove with:
#   Unregister-ScheduledTask -TaskName ClaudeLspReaper -Confirm:$false
#   (and delete lsp-reaper-launcher.vbs)

$Cap = 24
$log = Join-Path $env:USERPROFILE '.claude\logs\lsp-reaper.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log([string]$msg) {
    Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

$lspRe = 'typescript-language-server|\\typescript\\lib\\tsserver\.js|\\typescript\\lib\\typingsInstaller\.js'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match $lspRe }

if (-not $procs) { exit 0 }

$killed = 0
$alive = @()
foreach ($p in $procs) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    # PID-reuse guard: a real parent must predate its child.
    $orphan = (-not $parent) -or ($parent.CreationDate -gt $p.CreationDate)
    if ($orphan) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            $killed++
            Write-Log ("orphan pid={0} ppid={1} killed  cmd={2}" -f $p.ProcessId, $p.ParentProcessId, $p.CommandLine.Substring(0, [Math]::Min(120, $p.CommandLine.Length)))
        } catch {}
    } else {
        $alive += $p
    }
}

# Cap only the global-npm instances; leave VS Code's bundled tsserver alone.
$capped = @($alive | Where-Object { $_.CommandLine -match 'Roaming\\npm' } | Sort-Object CreationDate)
if ($capped.Count -gt $Cap) {
    foreach ($p in $capped[0..($capped.Count - $Cap - 1)]) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            $killed++
            Write-Log ("over-cap pid={0} killed (count={1} cap={2})" -f $p.ProcessId, $capped.Count, $Cap)
        } catch {}
    }
}

if ($killed -gt 0) { Write-Log ("reaped {0} of {1} LSP processes" -f $killed, @($procs).Count) }
exit 0
