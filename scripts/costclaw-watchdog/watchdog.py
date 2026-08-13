#!/usr/bin/env python3
"""CostClaw nightly spend watchdog: run `costclaw audit --json` over the local
Claude Code logs, diff cumulative spend against last night's snapshot to get
the day's burn (total and per project), alert by email when the shape looks
like an incident, and render a 30-night trend board.

Anomaly rules (guarding the $227-API-key-incident shape):
  - day spend > 2x the trailing-7-night mean AND > $50
  - day spend > $250 absolute
  - cache hit rate dropped more than 3 points vs last night
  - a single project burned > $150 in one day
First night just records a baseline — no alert.

Usage: python watchdog.py [--no-alert]
"""

import argparse
import importlib.util
import json
import os
import subprocess
from datetime import datetime
from html import escape

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIEFING_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "fleet-briefing")
HISTORY = os.path.join(SCRIPT_DIR, "history.jsonl")
OUT_DIR = os.path.join(SCRIPT_DIR, "out")
# Pin the CLI version: the parser trusts schemaVersion 1 fields; bump deliberately.
COSTCLAW = "costclaw@0.5.0"

_spec = importlib.util.spec_from_file_location(
    "briefing", os.path.join(BRIEFING_DIR, "briefing.py")
)
briefing = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(briefing)


def run_audit():
    proc = subprocess.run(
        ["npx", "--yes", COSTCLAW, "audit", "--json"],
        capture_output=True,
        timeout=600,
        shell=(os.name == "nt"),
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "costclaw audit failed: " + proc.stderr.decode(errors="replace")[:300]
        )
    return json.loads(proc.stdout.decode("utf-8", errors="replace"))


def snapshot(audit):
    u = audit["usageMetrics"]
    return {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "spend": u["spendUsd"],
        "cache_hit": u["cacheHitRate"],
        "sessions": u["sessionsCount"],
        "tokens": u["totalTokens"],
        "score": audit.get("overallScore"),
        "waste": audit.get("headlineWasteUsd"),
        "projects": {p["slug"]: p["costUsd"] for p in u.get("topProjects") or []},
    }


def load_history():
    out = []
    try:
        with open(HISTORY, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except FileNotFoundError:
        pass
    return out


def day_deltas(history, snap):
    """Per-night spend deltas from cumulative snapshots (skips the first)."""
    days = []
    prev = None
    for rec in history + [snap]:
        if prev is not None:
            days.append(
                {
                    "ts": rec["ts"][:10],
                    "spend": max(0.0, rec["spend"] - prev["spend"]),
                    "cache_drop": (prev["cache_hit"] - rec["cache_hit"]) * 100,
                    "projects": {
                        k: max(0.0, v - (prev["projects"].get(k) or 0.0))
                        for k, v in rec["projects"].items()
                    },
                }
            )
        prev = rec
    return days


def find_anomalies(days):
    if not days:
        return []
    today = days[-1]
    prior = [d["spend"] for d in days[:-1]][-7:]
    mean7 = sum(prior) / len(prior) if prior else None
    anomalies = []
    if mean7 is not None and today["spend"] > 2 * mean7 and today["spend"] > 50:
        anomalies.append(
            "Day spend $%.0f is %.1fx the trailing-7 mean ($%.0f)"
            % (today["spend"], today["spend"] / max(mean7, 0.01), mean7)
        )
    if today["spend"] > 250:
        anomalies.append(
            "Day spend $%.0f exceeds the $250 absolute ceiling" % today["spend"]
        )
    if today["cache_drop"] > 3:
        anomalies.append(
            "Cache hit rate dropped %.1f points overnight" % today["cache_drop"]
        )
    for slug, d in sorted(today["projects"].items(), key=lambda kv: -kv[1]):
        if d > 150:
            anomalies.append("Project %s burned $%.0f in one day" % (slug, d))
    return anomalies


def render(snap, days, anomalies):
    bars = ""
    recent = days[-30:]
    peak = max((d["spend"] for d in recent), default=1) or 1
    for d in recent:
        h = max(3, round(d["spend"] / peak * 120))
        color = "#d03b3b" if (anomalies and d is recent[-1]) else "#2a78d6"
        bars += (
            '<div class="bar" title="%s — $%.2f"><div class="fill" style="height:%dpx;background:%s"></div>'
            '<div class="bl">%s</div></div>'
            % (d["ts"], d["spend"], h, color, d["ts"][5:])
        )
    anom_html = (
        "".join(
            '<li><span style="color:#d03b3b">■</span> %s</li>' % escape(a)
            for a in anomalies
        )
        if anomalies
        else '<li class="ok">No anomalies — burn is in profile.</li>'
    )
    today = days[-1] if days else None
    tiles = (
        (
            '<div class="tile"><div class="l">Yesterday burn</div><div class="v">%s</div><div class="s">API-equivalent</div></div>'
            % (("$%.0f" % today["spend"]) if today else "baseline")
        )
        + '<div class="tile"><div class="l">Cache hit</div><div class="v">%.1f%%</div><div class="s">cumulative</div></div>'
        % (snap["cache_hit"] * 100)
        + '<div class="tile"><div class="l">Setup score</div><div class="v">%s</div><div class="s">costclaw audit</div></div>'
        % (snap["score"] if snap["score"] is not None else "?")
        + '<div class="tile"><div class="l">Recoverable</div><div class="v">$%.0f</div><div class="s">cache-miss exposure</div></div>'
        % (snap["waste"] or 0)
    )
    return """<title>CostClaw Watchdog</title>
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
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:20px; }
  .tile { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:14px 16px; }
  .tile .l { color:var(--ink2); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .tile .v { font-size:30px; font-weight:650; margin:4px 0 2px; }
  .tile .s { color:var(--muted); font-size:12px; }
  section { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  h2 { font-size:14px; margin:0 0 10px; color:var(--ink2); text-transform:uppercase; letter-spacing:.04em; }
  ul { margin:0; padding-left:2px; list-style:none; font-size:14px; } li { padding:3px 0; }
  .ok { color:#0ca30c; font-weight:600; }
  .chart { display:flex; align-items:flex-end; gap:4px; min-height:150px; overflow-x:auto; padding-top:6px; }
  .bar { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .fill { width:18px; border-radius:4px 4px 0 0; }
  .bl { font-size:10px; color:var(--muted); font-variant-numeric:tabular-nums; }
</style>
<div class="wrap">
  <h1>CostClaw Watchdog</h1>
  <div class="stamp">Snapshot %s · nightly at 00:07</div>
  <div class="tiles">%s</div>
  <section><h2>Anomalies</h2><ul>%s</ul></section>
  <section><h2>Nightly burn (last 30)</h2><div class="chart">%s</div></section>
</div>
""" % (
        escape(snap["ts"]),
        tiles,
        anom_html,
        bars
        or '<span class="muted" style="color:var(--muted)">baseline night — trend starts tomorrow</span>',
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-alert", action="store_true")
    args = ap.parse_args()

    briefing.load_dotenv()  # Resend config for alerts lives in the briefing .env
    audit = run_audit()
    snap = snapshot(audit)
    history = load_history()
    days = day_deltas(history, snap)
    anomalies = find_anomalies(days)

    with open(HISTORY, "a", encoding="utf-8") as f:
        f.write(json.dumps(snap) + "\n")
    os.makedirs(OUT_DIR, exist_ok=True)
    board = render(snap, days, anomalies)
    with open(os.path.join(OUT_DIR, "burn.html"), "w", encoding="utf-8") as f:
        f.write(board)

    today_spend = days[-1]["spend"] if days else None
    print(
        "snapshot: cumulative $%.2f | day %s | anomalies %d"
        % (
            snap["spend"],
            ("$%.2f" % today_spend) if today_spend is not None else "baseline",
            len(anomalies),
        )
    )

    if anomalies and not args.no_alert:
        try:
            briefing.send_email(
                board,
                "CostClaw watchdog: %d anomal%s — $%.0f burned"
                % (
                    len(anomalies),
                    "ies" if len(anomalies) > 1 else "y",
                    today_spend or 0,
                ),
            )
            print("alert: sent")
        except Exception as e:
            print("alert: FAILED %s: %s" % (type(e).__name__, e))


if __name__ == "__main__":
    main()
