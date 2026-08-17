# correction-tracker.ps1 - UserPromptSubmit
# Genesis-latency fix: "NEVER quiz me" took ~8 corrections across 6 months to become a
# rule because promotion depended on Wes noticing the repetition. This hook buckets
# correction-shaped prompts into corrections.jsonl; on the 2nd occurrence of a bucket
# it injects context ordering the session to draft the CLAUDE.md rule line NOW and
# present it for approval. A bucket marked {"bucket":"<name>","promoted":true} stops
# nagging. The log doubles as the fire-signal instrument for Tier 2 rules: a rule
# works iff its bucket stops accruing records.
$raw = [Console]::In.ReadToEnd()
try { $evt = $raw | ConvertFrom-Json } catch { exit 0 }
$p = [string]$evt.prompt
if ([string]::IsNullOrWhiteSpace($p) -or $p.Length -gt 4000) { exit 0 }

$buckets = [ordered]@{
  'decide-dont-quiz'  = '(?i)(stop\s+(fucking\s+)?(quizzing|testing)\s+me|don''?t\s+ask\s+me|you\s+(decide|choose)\s|just\s+(decide|pick\s+one))'
  'already-told-you'  = '(?i)(\bi\s+(already|just)\s+(told|said|asked)\s+you\b|how\s+many\s+times|you\s+keep\s+(doing|asking|using|adding))'
  'run-it-yourself'   = '(?i)why\s+(can''?t|don''?t)\s+you\s+just\s+run'
  'stop-doing-that'   = '(?i)\bstop\s+(fucking\s+)?(using|doing|running|touching|messing\s+with|fucking\s+with)\b'
  'question-not-task' = '(?i)(didn''?t\s+ask\s+you\s+to\s+(do|change|edit|build)|just\s+answer\s+(my|the)\s+question|only\s+asked\s+a\s+question)'
  'still-broken'      = '(?i)(still\s+(broken|not\s+working|doesn''?t\s+work)|\bno\b.{0,15}just\s+tested\s+it\s+again)'
}

$hit = $null
foreach ($b in $buckets.GetEnumerator()) { if ($p -match $b.Value) { $hit = $b.Key; break } }
if (-not $hit) { exit 0 }

$log = Join-Path $env:USERPROFILE '.claude\corrections.jsonl'
$snippet = $p.Substring(0, [Math]::Min(200, $p.Length)) -replace '[\r\n]+', ' '
$rec = @{ ts = [datetime]::UtcNow.ToString('o'); bucket = $hit; cwd = [string]$evt.cwd; snippet = $snippet } | ConvertTo-Json -Compress
Add-Content -Path $log -Value $rec -Encoding utf8

$entries = @()
foreach ($line in (Get-Content $log -ErrorAction SilentlyContinue)) {
  try { $entries += ($line | ConvertFrom-Json) } catch { }
}
$mine = @($entries | Where-Object { $_.bucket -eq $hit })
if (@($mine | Where-Object { $_.promoted -eq $true }).Count -gt 0) { exit 0 }
$count = @($mine | Where-Object { -not $_.promoted }).Count
if ($count -ge 2) {
  $dates = (@($mine | ForEach-Object { try { ([datetime]$_.ts).ToString('yyyy-MM-dd') } catch { [string]$_.ts } }) | Select-Object -Unique) -join ', '
  Write-Output "CORRECTION RECURRENCE: the correction pattern '$hit' has now fired $count times ($dates) per $log. Standing policy: in THIS response, after handling the prompt, draft the one CLAUDE.md rule line that would have prevented this correction and show it to Wes for approval. If he approves, add it to CLAUDE.md and append {`"bucket`":`"$hit`",`"promoted`":true} as a new line to $log so this reminder stops."
}
exit 0
