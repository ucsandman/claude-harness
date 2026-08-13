#!/usr/bin/env python3
"""Launch Readiness Board: a local web console (http://localhost:4747) showing
per-project launch readiness across the active Vercel fleet, with clickable
re-checks — no terminal needed once running.

Checks per project:
  deploy  — latest Vercel deployment is READY
  domain  — every production alias answers HTTP < 400
  ci      — latest GitHub Actions run on the matching repo is green (or no CI)

Projects are auto-discovered from Vercel (updated in the last 45 days);
config.json can pin the list and map project → GitHub repo where the name
heuristic fails. Runs as a background server (Task Scheduler, at logon).
"""

import json
import os
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(SCRIPT_DIR, "config.json")
PORT = 4747
DISCOVER_DAYS = 45
GH_OWNER = "ucsandman"

_ctx = ssl.create_default_context()
_state = {"projects": {}, "checked": None}
_lock = threading.Lock()


def http_json(url, headers=None, timeout=15):
    req = urllib.request.Request(
        url, headers={"User-Agent": "launch-board/1.0", **(headers or {})}
    )
    with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
        return json.loads(r.read().decode("utf-8"))


def head_status(url, timeout=10):
    req = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "launch-board/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"repo_map": {}, "exclude": []}


def vercel_headers():
    return {"Authorization": "Bearer " + os.environ["VERCEL_TOKEN"]}


def gh_headers():
    return {
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Accept": "application/vnd.github+json",
    }


def discover_projects(cfg):
    payload = http_json(
        "https://api.vercel.com/v9/projects?limit=40", headers=vercel_headers()
    )
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=DISCOVER_DAYS)
    ).timestamp() * 1000
    names = [
        p["name"]
        for p in payload.get("projects", [])
        if (p.get("updatedAt") or 0) >= cutoff
        and p["name"] not in (cfg.get("exclude") or [])
    ]
    return sorted(names)


def guess_repo(project, cfg, repo_names):
    if project in (cfg.get("repo_map") or {}):
        return cfg["repo_map"][project]
    candidates = {project, project.replace("-site", ""), project.replace("-", "")}
    for r in repo_names:
        if r.lower() in {c.lower() for c in candidates}:
            return GH_OWNER + "/" + r
    return None


def list_repo_names():
    try:
        repos = http_json(
            "https://api.github.com/user/repos?per_page=100&type=owner",
            headers=gh_headers(),
        )
        return [r["name"] for r in repos]
    except Exception:
        return []


def check_project(name, repo):
    """Run the three checks; each is {status: ok|fail|warn|none, note}."""
    out = {"deploy": None, "domain": None, "ci": None}
    try:
        d = (
            http_json(
                "https://api.vercel.com/v6/deployments?projectId=%s&limit=1&target=production"
                % name,
                headers=vercel_headers(),
            ).get("deployments")
            or []
        )
        if d:
            state = d[0].get("state") or d[0].get("readyState")
            out["deploy"] = {
                "status": "ok" if state == "READY" else "fail",
                "note": state or "?",
            }
        else:
            out["deploy"] = {"status": "warn", "note": "no prod deploys"}
    except Exception as e:
        out["deploy"] = {"status": "warn", "note": "vercel: " + type(e).__name__}
    try:
        doms = (
            http_json(
                "https://api.vercel.com/v9/projects/%s/domains?limit=10" % name,
                headers=vercel_headers(),
            ).get("domains")
            or []
        )
        prod = [x["name"] for x in doms if not x["name"].endswith(".vercel.app")] or [
            x["name"] for x in doms
        ]
        if prod:
            bad = []
            for dom in prod[:3]:
                code = head_status("https://" + dom)
                if code is None or code >= 400:
                    bad.append("%s→%s" % (dom, code))
            out["domain"] = (
                {"status": "ok", "note": ", ".join(prod[:3])}
                if not bad
                else {"status": "fail", "note": "; ".join(bad)}
            )
        else:
            out["domain"] = {"status": "warn", "note": "no domains"}
    except Exception as e:
        out["domain"] = {"status": "warn", "note": "domains: " + type(e).__name__}
    if repo:
        try:
            runs = (
                http_json(
                    "https://api.github.com/repos/%s/actions/runs?per_page=1" % repo,
                    headers=gh_headers(),
                ).get("workflow_runs")
                or []
            )
            if runs:
                c = runs[0].get("conclusion")
                out["ci"] = {
                    "status": "ok"
                    if c == "success"
                    else ("warn" if c is None else "fail"),
                    "note": (runs[0].get("name") or "run")
                    + ": "
                    + (c or runs[0].get("status") or "?"),
                }
            else:
                out["ci"] = {"status": "none", "note": "no CI"}
        except Exception as e:
            out["ci"] = {"status": "warn", "note": "gh: " + type(e).__name__}
    else:
        out["ci"] = {"status": "none", "note": "no repo match"}
    return out


def refresh(project=None):
    cfg = load_config()
    with _lock:
        known = dict(_state["projects"])
    if project is None:
        names = discover_projects(cfg)
        repo_names = list_repo_names()
        targets = {n: guess_repo(n, cfg, repo_names) for n in names}
    else:
        repo_names = list_repo_names()
        targets = {project: guess_repo(project, cfg, repo_names)}
    for name, repo in targets.items():
        checks = check_project(name, repo)
        ready = all(c["status"] in ("ok", "none") for c in checks.values())
        known[name] = {
            "repo": repo,
            "checks": checks,
            "ready": ready,
            "checked": datetime.now().strftime("%H:%M:%S"),
        }
    with _lock:
        if project is None:
            _state["projects"] = {k: known[k] for k in sorted(targets)}
        else:
            _state["projects"].update({project: known[project]})
        _state["checked"] = datetime.now().strftime("%a %b %d, %Y %H:%M:%S")
    return targets.keys()


CHIP = {
    "ok": ("#0ca30c", "●"),
    "fail": ("#d03b3b", "■"),
    "warn": ("#fab219", "▲"),
    "none": ("#898781", "—"),
}


def render():
    with _lock:
        projects = dict(_state["projects"])
        checked = _state["checked"]
    rows = ""
    for name, p in projects.items():
        cells = ""
        for key in ("deploy", "domain", "ci"):
            c = p["checks"][key]
            color, icon = CHIP[c["status"]]
            cells += (
                '<td><span style="color:%s">%s</span> <span class="note">%s</span></td>'
                % (color, icon, escape(c["note"][:60]))
            )
        badge = (
            '<span class="ready">READY</span>'
            if p["ready"]
            else '<span class="notready">NOT READY</span>'
        )
        rows += (
            '<tr id="row-%s"><td class="name">%s<div class="repo">%s</div></td>%s'
            "<td>%s</td><td><button onclick=\"recheck('%s')\">Re-check</button>"
            '<div class="note">%s</div></td></tr>'
            % (
                escape(name),
                escape(name),
                escape(p["repo"] or ""),
                cells,
                badge,
                escape(name),
                p["checked"],
            )
        )
    return """<!doctype html><html><head><meta charset="utf-8"><title>Launch Readiness</title>
<style>
  :root { color-scheme: light dark; }
  body { background:#0d0d0d; color:#fff; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:24px; }
  @media (prefers-color-scheme: light) { body { background:#f9f9f7; color:#0b0b0b; } table, .bar { background:#fcfcfb !important; border-color:rgba(11,11,11,.1) !important; } td { border-color:#e1e0d9 !important; } }
  .wrap { max-width:1000px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; } .stamp { color:#898781; font-size:13px; margin-bottom:16px; }
  .bar { background:#1a1a19; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:10px 14px; margin-bottom:14px; display:flex; gap:12px; align-items:center; }
  table { width:100%; border-collapse:collapse; font-size:14px; background:#1a1a19; border:1px solid rgba(255,255,255,.1); border-radius:10px; }
  th { text-align:left; font-size:12px; color:#898781; padding:10px; text-transform:uppercase; letter-spacing:.04em; }
  td { padding:8px 10px; border-top:1px solid #2c2c2a; vertical-align:top; }
  .name { font-weight:600; } .repo { font-size:11px; color:#898781; }
  .note { font-size:11px; color:#898781; }
  .ready { color:#0ca30c; font-weight:700; } .notready { color:#d03b3b; font-weight:700; }
  button { background:#2a78d6; border:none; color:#fff; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:12px; }
  button:hover { background:#1c5cab; } button:disabled { opacity:.5; }
</style></head><body><div class="wrap">
  <h1>Launch Readiness</h1>
  <div class="stamp">Last full sweep: @@CHECKED@@</div>
  <div class="bar"><button onclick="checkAll(this)">Check all projects</button>
    <span class="note">deploy = latest prod deployment READY · domain = prod aliases answer &lt;400 · ci = latest workflow run green</span></div>
  <table><tr><th>project</th><th>deploy</th><th>domain</th><th>ci</th><th>verdict</th><th></th></tr>@@ROWS@@</table>
</div>
<script>
async function recheck(name) {
  const row = document.getElementById('row-' + name);
  row.style.opacity = .4;
  await fetch('/check?project=' + encodeURIComponent(name), {method: 'POST'});
  location.reload();
}
async function checkAll(btn) {
  btn.disabled = true; btn.textContent = 'Checking…';
  await fetch('/check', {method: 'POST'});
  location.reload();
}
</script></body></html>""".replace(
        "@@CHECKED@@", escape(checked or "never — click Check all")
    ).replace("@@ROWS@@", rows)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: vulture — http.server dispatch
        if self.path.split("?")[0] == "/":
            self._send(200, render())
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):  # noqa: vulture — http.server dispatch
        path, _, query = self.path.partition("?")
        if path == "/check":
            project = None
            if query.startswith("project="):
                project = urllib.parse.unquote(query.split("=", 1)[1])
            try:
                refresh(project)
                self._send(200, json.dumps({"ok": True}), "application/json")
            except Exception as e:
                self._send(
                    500, json.dumps({"ok": False, "error": str(e)}), "application/json"
                )
        else:
            self._send(404, "not found", "text/plain")

    def log_message(self, _fmt, *_args):  # noqa: vulture — http.server dispatch
        pass


def main():
    threading.Thread(target=lambda: refresh(None), daemon=True).start()  # warm sweep
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Launch Readiness Board: http://localhost:%d" % PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
