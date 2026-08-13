#!/usr/bin/env python3
"""Fleet morning briefing: collect overnight Vercel / GitHub / Stripe / Sentry
state, render a self-contained HTML status board, optionally SMS a 3-line
summary via Twilio.

Provider tokens come from the process environment (the Bash secrets wiring
loads them); briefing-specific config comes from .env next to this file.
Collectors fail independently — a partial board beats no board — but the
script exits non-zero if every collector fails.

Usage:
  python briefing.py            # collect + write out/briefing.{json,html}
  python briefing.py --sms      # also send the SMS (needs Twilio config)
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html import escape

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SCRIPT_DIR, "out")
WINDOW_HOURS = 24
GITHUB_REPO_COUNT = 6
MEDITATION_LINE = "C:/Users/sandm/.claude/meditations/digests/latest-line.txt"


def meditation_line():
    """Last night's meditation takeaway, or "" when stale (>24h) or missing."""
    try:
        if datetime.now().timestamp() - os.path.getmtime(MEDITATION_LINE) > 86400:
            return ""
        with open(MEDITATION_LINE, encoding="utf-8") as f:
            return f.read().strip()[:300]
    except (OSError, UnicodeDecodeError):
        return ""


def load_dotenv():
    """Load .env next to this file; process env wins."""
    path = os.path.join(SCRIPT_DIR, ".env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass


def http_json(url, headers=None, data=None, timeout=15):
    merged = {
        "User-Agent": "fleet-briefing/1.0"
    }  # default urllib UA gets 403'd by some CDNs
    merged.update(headers or {})
    req = urllib.request.Request(url, headers=merged, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def collector(fn):
    """Run a collector; normalize to {ok, data|error}."""
    try:
        return {"ok": True, "data": fn()}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__ + ": " + str(e)}


# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------


def collect_vercel():
    token = os.environ.get("VERCEL_TOKEN")
    if not token:
        raise RuntimeError("VERCEL_TOKEN not set")
    payload = http_json(
        "https://api.vercel.com/v6/deployments?limit=60",
        headers={"Authorization": "Bearer " + token},
    )
    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)
    ).timestamp() * 1000
    projects = {}
    overnight_errors = []
    for d in payload.get("deployments", []):
        name = d.get("name") or "?"
        state = d.get("state") or d.get("readyState") or "?"
        created = d.get("created") or 0
        if name not in projects:  # list is newest-first: first hit = latest
            projects[name] = {
                "project": name,
                "state": state,
                "created": created,
                "url": d.get("url") or "",
                "uid": d.get("uid") or "",
            }
        if state == "ERROR" and created >= cutoff:
            overnight_errors.append({"project": name, "created": created})
    return {"projects": list(projects.values()), "overnight_errors": overnight_errors}


def collect_github():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get(
        "GITHUB_PERSONAL_ACCESS_TOKEN"
    )
    if not token:
        raise RuntimeError("GITHUB_TOKEN not set")
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
    }
    repos = http_json(
        "https://api.github.com/user/repos?sort=pushed&per_page=%d&type=owner"
        % GITHUB_REPO_COUNT,
        headers=headers,
    )
    out = []
    for r in repos:
        full = r.get("full_name")
        runs = http_json(
            "https://api.github.com/repos/%s/actions/runs?per_page=1" % full,
            headers=headers,
        ).get("workflow_runs", [])
        latest = runs[0] if runs else None
        out.append(
            {
                "repo": full,
                "pushed_at": r.get("pushed_at"),
                "run_status": latest.get("status") if latest else None,
                "run_conclusion": latest.get("conclusion") if latest else None,
                "run_name": latest.get("name") if latest else None,
                "run_url": latest.get("html_url") if latest else None,
                "run_id": latest.get("id") if latest else None,
            }
        )
    return {"repos": out}


def collect_stripe():
    key = os.environ.get("STRIPE_LIVE_SECRET_KEY") or os.environ.get(
        "STRIPE_SECRET_KEY"
    )
    if not key:
        raise RuntimeError("STRIPE_LIVE_SECRET_KEY not set")
    since = int(
        (datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).timestamp()
    )
    payload = http_json(
        "https://api.stripe.com/v1/charges?limit=100&created[gte]=%d" % since,
        headers={"Authorization": "Bearer " + key},
    )
    gross = {}
    count = 0
    refunds = 0
    refunded_amount = {}
    for c in payload.get("data", []):
        cur = (c.get("currency") or "usd").upper()
        if c.get("status") == "succeeded":
            count += 1
            gross[cur] = gross.get(cur, 0) + (c.get("amount") or 0)
        if (c.get("amount_refunded") or 0) > 0:
            refunds += 1
            refunded_amount[cur] = refunded_amount.get(cur, 0) + c["amount_refunded"]
    return {
        "charge_count": count,
        "gross": gross,  # minor units by currency
        "refund_count": refunds,
        "refunded": refunded_amount,  # minor units by currency
    }


def collect_sentry():
    token = os.environ.get("SENTRY_AUTH_TOKEN")
    if not token:
        raise RuntimeError("SENTRY_AUTH_TOKEN not set")
    headers = {"Authorization": "Bearer " + token}
    orgs = http_json("https://sentry.io/api/0/organizations/", headers=headers)
    out = []
    for org in orgs:
        slug = org.get("slug")
        issues = http_json(
            "https://sentry.io/api/0/organizations/%s/issues/?query=%s&limit=25&statsPeriod=24h"
            % (slug, urllib.parse.quote("is:unresolved firstSeen:-24h")),
            headers=headers,
        )
        out.append(
            {
                "org": slug,
                "new_issues": len(issues),
                "titles": [i.get("title", "")[:90] for i in issues[:5]],
            }
        )
    return {"orgs": out}


# ---------------------------------------------------------------------------
# Anomalies + summary
# ---------------------------------------------------------------------------


def money(minor_by_cur):
    if not minor_by_cur:
        return "$0"
    return ", ".join(
        ("$%.2f" % (v / 100)) if cur == "USD" else ("%.2f %s" % (v / 100, cur))
        for cur, v in sorted(minor_by_cur.items())
    )


def analyze(results):
    anomalies = []
    v = results["vercel"]
    if v["ok"]:
        for p in v["data"]["projects"]:
            if p["state"] == "ERROR":
                anomalies.append(
                    {
                        "level": "critical",
                        "text": "Vercel deploy ERROR: " + p["project"],
                    }
                )
    g = results["github"]
    if g["ok"]:
        for r in g["data"]["repos"]:
            if r["run_conclusion"] == "failure":
                anomalies.append({"level": "serious", "text": "CI red: " + r["repo"]})
    s = results["stripe"]
    if s["ok"] and s["data"]["refund_count"] > 0:
        anomalies.append(
            {
                "level": "warning",
                "text": "Stripe refunds: %d (%s)"
                % (s["data"]["refund_count"], money(s["data"]["refunded"])),
            }
        )
    e = results["sentry"]
    if e["ok"]:
        for org in e["data"]["orgs"]:
            if org["new_issues"] >= 10:
                anomalies.append(
                    {
                        "level": "warning",
                        "text": "Sentry spike in %s: %d new issues"
                        % (org["org"], org["new_issues"]),
                    }
                )
    for name, r in results.items():
        if not r["ok"]:
            anomalies.append(
                {
                    "level": "warning",
                    "text": name + " collector failed: " + r["error"][:120],
                }
            )
    return anomalies


def sms_lines(results, anomalies):
    v, g, s, e = (
        results["vercel"],
        results["github"],
        results["stripe"],
        results["sentry"],
    )
    if v["ok"]:
        total = len(v["data"]["projects"])
        green = sum(1 for p in v["data"]["projects"] if p["state"] == "READY")
        deploys = "deploys %d/%d green" % (green, total)
    else:
        deploys = "deploys ?"
    if g["ok"]:
        runs = [r for r in g["data"]["repos"] if r["run_conclusion"]]
        ok = sum(1 for r in runs if r["run_conclusion"] == "success")
        ci = "CI %d/%d green" % (ok, len(runs)) if runs else "CI quiet"
    else:
        ci = "CI ?"
    line1 = "Fleet 7am: %s, %s" % (deploys, ci)
    stripe_part = (
        "Stripe %s (%d)" % (money(s["data"]["gross"]), s["data"]["charge_count"])
        if s["ok"]
        else "Stripe ?"
    )
    sentry_part = (
        "Sentry %d new" % sum(o["new_issues"] for o in e["data"]["orgs"])
        if e["ok"]
        else "Sentry ?"
    )
    line2 = stripe_part + "; " + sentry_part
    if anomalies:
        line3 = "!! " + "; ".join(a["text"] for a in anomalies[:3])
    else:
        line3 = "All clear."
    board = os.environ.get("BRIEFING_BOARD_URL")
    if board:
        line3 += " " + board
    return [line1, line2, line3]


EMAIL_TOKENS = {  # light-theme literals; Gmail strips CSS custom properties
    "surface": "#fcfcfb",
    "page": "#f9f9f7",
    "ink": "#0b0b0b",
    "ink2": "#52514e",
    "muted": "#898781",
    "grid": "#e1e0d9",
    "ring": "rgba(11,11,11,.10)",
}


def email_safe(html):
    """Bake var(--x) tokens to light-theme literals and wrap as a full document
    so the board renders in email clients (no custom-property support)."""
    for name, val in EMAIL_TOKENS.items():
        html = html.replace("var(--%s)" % name, val)
    return (
        '<!doctype html><html><head><meta charset="utf-8"></head><body>'
        + html
        + "</body></html>"
    )


def send_email(board_html, subject):
    key = os.environ.get("RESEND_API_KEY")
    to = os.environ.get("BRIEFING_EMAIL_TO")
    sender = os.environ.get("BRIEFING_EMAIL_FROM")
    missing = [
        n
        for n, v in [
            ("RESEND_API_KEY", key),
            ("BRIEFING_EMAIL_TO", to),
            ("BRIEFING_EMAIL_FROM", sender),
        ]
        if not v
    ]
    if missing:
        raise RuntimeError("email skipped, missing: " + ", ".join(missing))
    payload = json.dumps(
        {
            "from": "Fleet Briefing <%s>" % sender,
            "to": [to],
            "subject": subject,
            "html": email_safe(board_html),
        }
    ).encode()
    http_json(
        "https://api.resend.com/emails",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        data=payload,
    )


def send_discord(body):
    """POST the ping to a Discord webhook (entity-free, unlike toll-free SMS)."""
    webhook = os.environ.get("BRIEFING_DISCORD_WEBHOOK")
    if not webhook:
        raise RuntimeError("ping skipped, missing: BRIEFING_DISCORD_WEBHOOK")
    payload = json.dumps({"content": body[:1900]}).encode()
    req = urllib.request.Request(
        webhook,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "fleet-briefing/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def send_ping(body):
    """Morning ping: Discord webhook first; Twilio SMS only as fallback
    (toll-free SMS needs a verified legal entity, so it's dormant)."""
    if os.environ.get("BRIEFING_DISCORD_WEBHOOK"):
        send_discord(body)
        return "discord"
    send_sms(body)
    return "sms"


def send_sms(body):
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth = os.environ.get("TWILIO_AUTH_TOKEN")
    from_no = os.environ.get("TWILIO_FROM_NUMBER")
    to_no = os.environ.get("BRIEFING_SMS_TO")
    missing = [
        n
        for n, v in [
            ("TWILIO_ACCOUNT_SID", sid),
            ("TWILIO_AUTH_TOKEN", auth),
            ("TWILIO_FROM_NUMBER", from_no),
            ("BRIEFING_SMS_TO", to_no),
        ]
        if not v
    ]
    if missing:
        raise RuntimeError("SMS skipped, missing: " + ", ".join(missing))
    data = urllib.parse.urlencode({"From": from_no, "To": to_no, "Body": body}).encode()
    basic = base64.b64encode(("%s:%s" % (sid, auth)).encode()).decode()
    http_json(
        "https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json" % sid,
        headers={"Authorization": "Basic " + basic},
        data=data,
    )


# ---------------------------------------------------------------------------
# HTML board
# ---------------------------------------------------------------------------

STATUS = {
    "good": ("#0ca30c", "●", "OK"),
    "warning": ("#fab219", "▲", "Warn"),
    "serious": ("#ec835a", "▲", "Attention"),
    "critical": ("#d03b3b", "■", "Critical"),
}


def chip(level, label):
    color, icon, _ = STATUS[level]
    return '<span class="chip"><span style="color:%s">%s</span> %s</span>' % (
        color,
        icon,
        escape(label),
    )


def deploy_chip(state):
    return {
        "READY": chip("good", "READY"),
        "ERROR": chip("critical", "ERROR"),
        "BUILDING": chip("warning", "BUILDING"),
        "QUEUED": chip("warning", "QUEUED"),
        "CANCELED": chip("warning", "CANCELED"),
    }.get(state, chip("warning", state or "?"))


def ci_chip(conclusion, status):
    if conclusion == "success":
        return chip("good", "green")
    if conclusion == "failure":
        return chip("critical", "red")
    if status == "in_progress":
        return chip("warning", "running")
    if conclusion is None and status is None:
        return '<span class="muted">no CI</span>'
    return chip("warning", conclusion or status or "?")


def render_html(results, anomalies, generated):
    v, g, s, e = (
        results["vercel"],
        results["github"],
        results["stripe"],
        results["sentry"],
    )

    def tile(label, value, sub, level=None):
        dot = ""
        if level:
            color, icon, _ = STATUS[level]
            dot = '<span style="color:%s;font-size:14px"> %s</span>' % (color, icon)
        return (
            '<div class="tile"><div class="tile-label">%s</div>'
            '<div class="tile-value">%s%s</div><div class="tile-sub">%s</div></div>'
            % (escape(label), escape(str(value)), dot, escape(sub))
        )

    tiles = []
    if v["ok"]:
        total = len(v["data"]["projects"])
        green = sum(1 for p in v["data"]["projects"] if p["state"] == "READY")
        tiles.append(
            tile(
                "Deploys green",
                "%d/%d" % (green, total),
                "latest state per Vercel project",
                "good" if green == total else "critical",
            )
        )
    else:
        tiles.append(tile("Deploys", "?", "Vercel collector failed", "warning"))
    if g["ok"]:
        runs = [r for r in g["data"]["repos"] if r["run_conclusion"]]
        ok = sum(1 for r in runs if r["run_conclusion"] == "success")
        tiles.append(
            tile(
                "CI green",
                "%d/%d" % (ok, len(runs)) if runs else "quiet",
                "latest run, %d most-recent repos" % len(g["data"]["repos"]),
                "good" if ok == len(runs) else "serious",
            )
        )
    else:
        tiles.append(tile("CI", "?", "GitHub collector failed", "warning"))
    if s["ok"]:
        tiles.append(
            tile(
                "Overnight revenue",
                money(s["data"]["gross"]),
                "%d charges, %d refunds, last %dh"
                % (s["data"]["charge_count"], s["data"]["refund_count"], WINDOW_HOURS),
                "warning" if s["data"]["refund_count"] else "good",
            )
        )
    else:
        tiles.append(tile("Revenue", "?", "Stripe collector failed", "warning"))
    if e["ok"]:
        new = sum(o["new_issues"] for o in e["data"]["orgs"])
        tiles.append(
            tile(
                "New Sentry issues",
                new,
                "first seen in last 24h",
                "good" if new < 10 else "warning",
            )
        )
    else:
        tiles.append(tile("Sentry", "?", "Sentry collector failed", "warning"))

    anom_html = (
        "".join(
            "<li>%s %s</li>" % (chip(a["level"], a["level"]), escape(a["text"]))
            for a in anomalies
        )
        if anomalies
        else '<li class="allclear">All clear — nothing needs you this morning.</li>'
    )

    deploy_rows = ""
    if v["ok"]:
        for p in sorted(
            v["data"]["projects"], key=lambda p: (p["state"] == "READY", p["project"])
        ):
            when = (
                datetime.fromtimestamp(p["created"] / 1000).strftime("%b %d %H:%M")
                if p["created"]
                else ""
            )
            deploy_rows += (
                "<tr><td>%s</td><td>%s</td><td class='muted'>%s</td></tr>"
                % (escape(p["project"]), deploy_chip(p["state"]), when)
            )

    ci_rows = ""
    if g["ok"]:
        for r in g["data"]["repos"]:
            link = (
                (
                    '<a href="%s">%s</a>'
                    % (escape(r["run_url"]), escape(r["run_name"] or "run"))
                )
                if r["run_url"]
                else '<span class="muted">—</span>'
            )
            ci_rows += "<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                escape(r["repo"]),
                ci_chip(r["run_conclusion"], r["run_status"]),
                link,
            )

    sentry_rows = ""
    if e["ok"]:
        for org in e["data"]["orgs"]:
            titles = (
                "<br>".join(escape(t) for t in org["titles"])
                or '<span class="muted">none</span>'
            )
            sentry_rows += (
                "<tr><td>%s</td><td>%d</td><td class='muted'>%s</td></tr>"
                % (escape(org["org"]), org["new_issues"], titles)
            )

    med = meditation_line()
    med_html = (
        '<section><h2>Nightly meditation</h2><ul class="anoms"><li>%s</li></ul></section>'
        % escape(med)
        if med
        else ""
    )

    return """<title>Fleet Briefing</title>
<style>
  :root { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
          --grid:#e1e0d9; --ring:rgba(11,11,11,.10); }
  @media (prefers-color-scheme: dark) {
    :root { --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --grid:#2c2c2a; --ring:rgba(255,255,255,.10); } }
  :root[data-theme="dark"] { --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --grid:#2c2c2a; --ring:rgba(255,255,255,.10); }
  :root[data-theme="light"] { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --grid:#e1e0d9; --ring:rgba(11,11,11,.10); }
  body { background:var(--page); color:var(--ink); font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
         margin:0; padding:24px; }
  .wrap { max-width:880px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 2px; } .stamp { color:var(--muted); font-size:13px; margin-bottom:20px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:20px; }
  .tile { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:14px 16px; }
  .tile-label { color:var(--ink2); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .tile-value { font-size:30px; font-weight:650; margin:4px 0 2px; }
  .tile-sub { color:var(--muted); font-size:12px; }
  section { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  h2 { font-size:14px; margin:0 0 10px; color:var(--ink2); text-transform:uppercase; letter-spacing:.04em; }
  ul.anoms { margin:0; padding-left:2px; list-style:none; } ul.anoms li { padding:3px 0; font-size:14px; }
  .allclear { color:#0ca30c; font-weight:600; }
  .chip { font-size:13px; font-weight:600; white-space:nowrap; }
  .tablewrap { overflow-x:auto; }
  table { width:100%%; border-collapse:collapse; font-size:14px; }
  td { padding:6px 10px 6px 0; border-top:1px solid var(--grid); vertical-align:top; font-variant-numeric:tabular-nums; }
  tr:first-child td { border-top:none; }
  .muted { color:var(--muted); } a { color:inherit; }
</style>
<div class="wrap">
  <h1>Fleet Briefing</h1>
  <div class="stamp">Generated %s · window: last %dh</div>
  <div class="tiles">%s</div>
  <section><h2>Needs attention</h2><ul class="anoms">%s</ul></section>%s
  <section><h2>Deploys (latest per project)</h2><div class="tablewrap"><table>%s</table></div></section>
  <section><h2>CI (latest run, most recently pushed repos)</h2><div class="tablewrap"><table>%s</table></div></section>
  <section><h2>Sentry (new issues, 24h)</h2><div class="tablewrap"><table>%s</table></div></section>
</div>
""" % (
        escape(generated),
        WINDOW_HOURS,
        "".join(tiles),
        anom_html,
        med_html,
        deploy_rows,
        ci_rows,
        sentry_rows,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sms", action="store_true", help="send the SMS summary")
    ap.add_argument("--email", action="store_true", help="email the board via Resend")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    load_dotenv()
    results = {
        "vercel": collector(collect_vercel),
        "github": collector(collect_github),
        "stripe": collector(collect_stripe),
        "sentry": collector(collect_sentry),
    }
    if not any(r["ok"] for r in results.values()):
        print("FATAL: every collector failed", file=sys.stderr)
        for name, r in results.items():
            print("  %s: %s" % (name, r["error"]), file=sys.stderr)
        sys.exit(1)

    anomalies = analyze(results)
    generated = datetime.now().strftime("%a %b %d, %Y %H:%M")

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "briefing.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"generated": generated, "results": results, "anomalies": anomalies},
            f,
            indent=2,
        )
    with open(os.path.join(args.out, "briefing.html"), "w", encoding="utf-8") as f:
        f.write(render_html(results, anomalies, generated))

    lines = sms_lines(results, anomalies)
    print("\n".join(lines))
    print("board: %s" % os.path.join(args.out, "briefing.html"))

    if args.email:
        subject = "Fleet 7am: " + (
            ("%d need attention — " % len(anomalies))
            + "; ".join(a["text"] for a in anomalies[:2])
            if anomalies
            else "all clear"
        )
        try:
            with open(os.path.join(args.out, "briefing.html"), encoding="utf-8") as f:
                send_email(f.read(), subject[:140])
            print("email: sent")
        except Exception as e:
            print("email: FAILED %s: %s" % (type(e).__name__, e))

    if args.sms:
        policy = (os.environ.get("BRIEFING_SMS_POLICY") or "daily").lower()
        if policy == "anomaly" and not anomalies:
            print("ping: skipped (policy=anomaly, all clear)")
        else:
            try:
                channel = send_ping("\n".join(lines))
                print("ping: sent via " + channel)
            except Exception as e:
                # Missing channel config or a send failure must not fail the run.
                print("ping: FAILED %s: %s" % (type(e).__name__, e))


if __name__ == "__main__":
    main()
