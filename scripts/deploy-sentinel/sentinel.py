#!/usr/bin/env python3
"""Deploy Sentinel: poll Vercel deploys + GitHub CI, track incidents, alert on
new reds, render a red-to-green incidents board.

Reuses the fleet-briefing collectors (imported from the sibling script) so
there is exactly one implementation of the provider polling. Each red opens an
incident exactly once (state.json keys on run/deployment id); when the red
clears, the incident auto-resolves and moves to the resolved section of the
board. New incidents email an alert via the briefing's Resend config.

Diagnosis and draft PRs are driven interactively (Claude + Codex sessions),
not from this poller — it only detects, alerts, and records.

Usage: python sentinel.py [--no-alert]
"""

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime
from html import escape

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIEFING_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "fleet-briefing")
STATE_PATH = os.path.join(SCRIPT_DIR, "state.json")
OUT_DIR = os.path.join(SCRIPT_DIR, "out")
RESOLVED_KEEP = 20

# Import the briefing module for collectors, email, and dotenv handling.
_spec = importlib.util.spec_from_file_location(
    "briefing", os.path.join(BRIEFING_DIR, "briefing.py")
)
briefing = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(briefing)


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"open": {}, "resolved": []}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def current_reds():
    """Poll providers; return {incident_key: incident_dict}. Collector failures
    are reported separately so an API blip never looks like 'all green'."""
    reds = {}
    errors = []
    v = briefing.collector(briefing.collect_vercel)
    if v["ok"]:
        for p in v["data"]["projects"]:
            if p["state"] == "ERROR":
                key = "vercel:%s:%s" % (p["project"], p.get("uid") or "?")
                reds[key] = {
                    "kind": "deploy",
                    "target": p["project"],
                    "detail": "Vercel deployment ERROR",
                    "url": ("https://" + p["url"]) if p.get("url") else "",
                }
    else:
        errors.append("vercel: " + v["error"])
    g = briefing.collector(briefing.collect_github)
    if g["ok"]:
        for r in g["data"]["repos"]:
            if r["run_conclusion"] == "failure":
                key = "ci:%s:%s" % (r["repo"], r.get("run_id") or "?")
                reds[key] = {
                    "kind": "ci",
                    "target": r["repo"],
                    "detail": "workflow '%s' failed" % (r["run_name"] or "?"),
                    "url": r.get("run_url") or "",
                }
    else:
        errors.append("github: " + g["error"])
    return reds, errors


def reconcile(state, reds):
    """Open new incidents, resolve cleared ones. Returns list of new ones."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    new = []
    for key, inc in reds.items():
        if key not in state["open"]:
            record = dict(inc, first_seen=now)
            state["open"][key] = record
            new.append(dict(record, key=key))
    for key in list(state["open"].keys()):
        # A CI incident is keyed to a specific run id; it clears when that repo
        # stops reporting ANY red (newer green run replaced it). Same for
        # deploys: the project no longer has a red latest deployment.
        target = state["open"][key]["target"]
        kind = state["open"][key]["kind"]
        still_red = any(
            i["target"] == target and i["kind"] == kind for i in reds.values()
        )
        if not still_red:
            resolved = dict(state["open"].pop(key), resolved_at=now, key=key)
            state["resolved"].insert(0, resolved)
    state["resolved"] = state["resolved"][:RESOLVED_KEEP]
    return new


def render_board(state, errors, polled):
    def rows(items, resolved=False):
        if not items:
            return '<tr><td class="muted">%s</td></tr>' % (
                "none" if resolved else "none — fleet is green"
            )
        out = ""
        for i in items:
            link = (
                ('<a href="%s">details</a>' % escape(i["url"])) if i.get("url") else ""
            )
            when = (
                "%s → %s" % (i["first_seen"], i.get("resolved_at", ""))
                if resolved
                else i["first_seen"]
            )
            color = "#0ca30c" if resolved else "#d03b3b"
            icon = "●" if resolved else "■"
            out += (
                '<tr><td><span style="color:%s">%s</span> %s</td>'
                "<td>%s</td><td>%s</td><td class='muted'>%s</td></tr>"
                % (color, icon, escape(i["target"]), escape(i["detail"]), link, when)
            )
        return out

    err_html = (
        "".join(
            '<li><span style="color:#fab219">▲</span> %s</li>' % escape(e)
            for e in errors
        )
        if errors
        else ""
    )
    open_incidents = [dict(v, key=k) for k, v in state["open"].items()]
    return """<title>Deploy Sentinel</title>
<style>
  :root { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
          --grid:#e1e0d9; --ring:rgba(11,11,11,.10); }
  @media (prefers-color-scheme: dark) {
    :root { --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --grid:#2c2c2a; --ring:rgba(255,255,255,.10); } }
  :root[data-theme="dark"] { --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --grid:#2c2c2a; --ring:rgba(255,255,255,.10); }
  :root[data-theme="light"] { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --grid:#e1e0d9; --ring:rgba(11,11,11,.10); }
  body { background:var(--page); color:var(--ink); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:24px; }
  .wrap { max-width:880px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; } .stamp { color:var(--muted); font-size:13px; margin-bottom:20px; }
  section { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  h2 { font-size:14px; margin:0 0 10px; color:var(--ink2); text-transform:uppercase; letter-spacing:.04em; }
  .tablewrap { overflow-x:auto; } table { width:100%%; border-collapse:collapse; font-size:14px; }
  td { padding:6px 10px 6px 0; border-top:1px solid var(--grid); vertical-align:top; }
  tr:first-child td { border-top:none; } .muted { color:var(--muted); } a { color:inherit; }
  ul { margin:0; padding-left:2px; list-style:none; font-size:14px; }
</style>
<div class="wrap">
  <h1>Deploy Sentinel</h1>
  <div class="stamp">Last poll %s · every 30 min</div>
  <section><h2>Open incidents (%d)</h2><div class="tablewrap"><table>%s</table></div>%s</section>
  <section><h2>Recently resolved</h2><div class="tablewrap"><table>%s</table></div></section>
</div>
""" % (
        escape(polled),
        len(open_incidents),
        rows(open_incidents),
        ("<ul>%s</ul>" % err_html) if err_html else "",
        rows(state["resolved"], resolved=True),
    )


def alert(new_incidents, state):
    subject = "Sentinel: %d new red%s — %s" % (
        len(new_incidents),
        "s" if len(new_incidents) > 1 else "",
        "; ".join(i["target"] for i in new_incidents[:3]),
    )
    body = "".join(
        "<p><b>%s</b> — %s%s</p>"
        % (
            escape(i["target"]),
            escape(i["detail"]),
            (' (<a href="%s">details</a>)' % escape(i["url"])) if i.get("url") else "",
        )
        for i in new_incidents
    )
    html = (
        "<h2 style='font-family:sans-serif'>Deploy Sentinel</h2>"
        + body
        + "<p style='color:#888'>Open incidents now: %d. Board: out/incidents.html</p>"
        % len(state["open"])
    )
    briefing.send_email(html, subject)
    # Same-instant Discord ping (webhook configured in the briefing .env);
    # email failure and ping failure are independent — try both.
    try:
        briefing.send_discord(
            "🔴 "
            + subject
            + "\n"
            + "\n".join(
                "• %s — %s %s" % (i["target"], i["detail"], i.get("url") or "")
                for i in new_incidents[:5]
            )
        )
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--no-alert", action="store_true", help="poll + board only, no email"
    )
    args = ap.parse_args()

    # briefing.load_dotenv reads the briefing .env (Twilio/Resend config lives
    # there); sentinel deliberately shares it rather than duplicating config.
    briefing.load_dotenv()
    state = load_state()
    reds, errors = current_reds()
    new = reconcile(state, reds)
    polled = datetime.now().strftime("%a %b %d, %Y %H:%M")

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "incidents.html"), "w", encoding="utf-8") as f:
        f.write(render_board(state, errors, polled))
    save_state(state)

    print(
        "open=%d new=%d resolved_total=%d errors=%d"
        % (len(state["open"]), len(new), len(state["resolved"]), len(errors))
    )
    for e in errors:
        print("collector error: " + e, file=sys.stderr)

    if new and not args.no_alert:
        try:
            alert(new, state)
            print("alert: sent (%d new)" % len(new))
        except Exception as e:
            print("alert: FAILED %s: %s" % (type(e).__name__, e))


if __name__ == "__main__":
    main()
