Set-StrictMode -Version Latest

function Get-DeskViewerHtml {
  param([string]$Root)
  $stopped = Test-DeskStop $Root

  # Each state file is read independently. A truncated or corrupt file must not
  # take the whole page down with it — that would lose the only UI route back to
  # clearing STOP, which is the exact failure a corrupted-state fix must prevent.
  $auditPath = Join-Path $Root 'state\audit.jsonl'
  try {
    $audit = if (Test-Path $auditPath) { (Get-Content $auditPath -Tail 25) -join "`n" } else { '(nothing yet)' }
    if ([string]::IsNullOrEmpty($audit)) { $audit = '(nothing yet)' }
  } catch { $audit = '(unreadable)' }

  $snapPath = Join-Path $Root 'state\last-snapshot.json'
  try {
    $snapWindow = if (Test-Path $snapPath) { (Get-Content $snapPath -Raw | ConvertFrom-Json).window } else { '(none)' }
    if ([string]::IsNullOrEmpty($snapWindow)) { $snapWindow = '(none)' }
  } catch { $snapWindow = '(unreadable)' }

  try {
    $deny = (Get-DenyPattern (Join-Path $Root 'deny.txt')) -join ', '
    if ([string]::IsNullOrEmpty($deny)) { $deny = '(none)' }
  } catch { $deny = '(unreadable)' }

  # Encode file-sourced/window-title-sourced values before they reach the here-string.
  # A malicious web page can set its own tab title, which flows into last-snapshot.json
  # and audit.jsonl via `desk snapshot`/`desk windows`; <pre> stops whitespace collapsing,
  # not HTML parsing, so this is a real injection path without encoding.
  $snapWindow = [System.Net.WebUtility]::HtmlEncode([string]$snapWindow)
  $deny = [System.Net.WebUtility]::HtmlEncode([string]$deny)
  $audit = [System.Net.WebUtility]::HtmlEncode([string]$audit)

  $stateLabel = if ($stopped) { 'STOPPED' } else { 'ACTIVE' }
  $stateColor = if ($stopped) { '#dc2626' } else { '#16a34a' }
  $buttonText = if ($stopped) { 'Allow deskclaw to read the screen' } else { 'STOP deskclaw now' }
  $buttonTarget = if ($stopped) { '/go' } else { '/stop' }

  # Stage 2 arm switch. Only these buttons create/remove state\ACT-ARMED; the
  # CLI has no arm verb, so acting stays a human decision made on this page.
  $armed = Test-DeskArmed $Root
  $armLabel = if ($armed) { 'ARMED' } else { 'DISARMED' }
  $armColor = if ($armed) { '#d97706' } else { '#4b5563' }
  $armButtonText = if ($armed) { 'Disarm acting (click/type/key)' } else { 'Arm acting (click/type/key)' }
  $armButtonTarget = if ($armed) { '/disarm' } else { '/arm' }

  return @"
<!doctype html><html><head><meta charset="utf-8"><title>deskclaw</title>
<style>
body{font:16px system-ui;background:#0b0d10;color:#e6e8eb;margin:0;padding:32px;max-width:900px}
h1{font-size:22px;margin:0 0 4px} .sub{color:#9aa4b2;margin-bottom:24px}
.state{display:inline-block;padding:6px 14px;border-radius:999px;background:$stateColor;color:#fff;font-weight:600}
form{margin:24px 0} button{font:600 18px system-ui;padding:16px 28px;border:0;border-radius:10px;
background:$stateColor;color:#fff;cursor:pointer} button:hover{filter:brightness(1.1)}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#9aa4b2;margin:28px 0 8px}
pre{background:#12161b;padding:14px;border-radius:8px;overflow-x:auto;font-size:13px;white-space:pre-wrap}
</style></head><body>
<h1>deskclaw</h1>
<div class="sub">Desktop eye. Reading: <span class="state">$stateLabel</span> &nbsp; Acting: <span class="state" style="background:$armColor">$armLabel</span></div>
<form method="POST" action="$buttonTarget"><button type="submit">$buttonText</button></form>
<form method="POST" action="$armButtonTarget"><button type="submit" style="background:$armColor">$armButtonText</button></form>
<h2>Last snapshot</h2><pre>$snapWindow</pre>
<h2>Denylist (these windows are skipped entirely)</h2><pre>$deny</pre>
<h2>Recent activity</h2><pre>$audit</pre>
</body></html>
"@
}

function Test-DeskViewerOrigin {
  # Takes header VALUES, not the HttpListenerRequest itself, so this is testable
  # without constructing a real listener request (it has no public constructor).
  param([string]$Origin, [string]$Referer, [int]$Port)
  $expected = "http://localhost:$Port"
  if ($Origin) { return ($Origin -eq $expected) }
  if ($Referer) { return ($Referer -eq $expected) -or $Referer.StartsWith("$expected/") }
  return $false
}

function Send-DeskViewerText {
  param([System.Net.HttpListenerContext]$Ctx, [int]$StatusCode, [string]$Text)
  $Ctx.Response.StatusCode = $StatusCode
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $Ctx.Response.ContentType = 'text/plain; charset=utf-8'
  $Ctx.Response.ContentLength64 = $bytes.Length
  $Ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Ctx.Response.Close()
}

function Start-DeskViewer {
  param([string]$Root, [int]$Port = 4849)
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$Port/")
  try {
    $listener.Start()
  } catch {
    Write-Host "deskclaw viewer: could not bind port $Port (already in use?)."
    exit 1
  }
  Write-Host "deskclaw viewer: http://localhost:$Port  (Ctrl+C to stop)"
  Write-DeskAudit $Root 'viewer' 'n/a' "start;port=$Port"
  try {
    while ($listener.IsListening) {
      $ctx = $listener.GetContext()
      try {
        $path = $ctx.Request.Url.AbsolutePath
        if ($ctx.Request.HttpMethod -eq 'POST' -and ($path -in @('/stop', '/go', '/arm', '/disarm'))) {
          if (-not (Test-DeskViewerOrigin $ctx.Request.Headers['Origin'] $ctx.Request.Headers['Referer'] $Port)) {
            Send-DeskViewerText $ctx 403 'forbidden: cross-origin request refused'
            continue
          }
          switch ($path) {
            '/stop' {
              New-Item -ItemType Directory -Path (Join-Path $Root 'state') -Force | Out-Null
              Set-Content -LiteralPath (Join-Path $Root 'state\STOP') -Value 'stopped from viewer'
              # STOP is the panic button: it also disarms acting, so clearing
              # STOP later does not silently re-enable clicks.
              Remove-Item -LiteralPath (Join-Path $Root 'state\ACT-ARMED') -ErrorAction SilentlyContinue
              Write-DeskAudit $Root 'stop' 'n/a' 'stop=set;armed=cleared;source=viewer'
            }
            '/go' {
              Remove-Item -LiteralPath (Join-Path $Root 'state\STOP') -ErrorAction SilentlyContinue
              Write-DeskAudit $Root 'go' 'n/a' 'stop=cleared;source=viewer'
            }
            '/arm' {
              New-Item -ItemType Directory -Path (Join-Path $Root 'state') -Force | Out-Null
              Set-Content -LiteralPath (Join-Path $Root 'state\ACT-ARMED') -Value 'armed from viewer'
              Write-DeskAudit $Root 'arm' 'n/a' 'armed=set;source=viewer'
            }
            '/disarm' {
              Remove-Item -LiteralPath (Join-Path $Root 'state\ACT-ARMED') -ErrorAction SilentlyContinue
              Write-DeskAudit $Root 'disarm' 'n/a' 'armed=cleared;source=viewer'
            }
          }
        }
        if ($ctx.Request.HttpMethod -eq 'POST') {
          $ctx.Response.StatusCode = 303
          $ctx.Response.RedirectLocation = '/'
          $ctx.Response.Close()
          continue
        }
        $html = Get-DeskViewerHtml $Root
        $bytes = [Text.Encoding]::UTF8.GetBytes($html)
        $ctx.Response.ContentType = 'text/html; charset=utf-8'
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.Close()
      } catch {
        try { Send-DeskViewerText $ctx 500 'internal error' } catch {}
      }
    }
  } finally { $listener.Stop() }
}
