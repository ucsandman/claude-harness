#!/usr/bin/env python3
"""Skill-usage telemetry: backfill from historical session transcripts and
render the instrument panel (out/skills.html).

Data layer: ~/.claude/telemetry/skill-usage.jsonl — fed live by the
skill-telemetry.py Stop hook (one record per turn) and by `--backfill` here
(one record per historical session). The parser is imported from the hook so
there is exactly one implementation.

Usage:
  python report.py --backfill   # one-time: mine ~/.claude/projects/*/*.jsonl
  python report.py              # render out/skills.html from the data layer
"""

import argparse
import glob
import importlib.util
import json
import os
from datetime import datetime, timedelta
from html import escape

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, ".claude", "telemetry", "skill-usage.jsonl")
PROJECTS = os.path.join(HOME, ".claude", "projects")
SKILLS_DIR = os.path.join(HOME, ".claude", "skills")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
BACKFILL_DAYS = 60

_spec = importlib.util.spec_from_file_location(
    "skill_telemetry", os.path.join(HOME, ".claude", "hooks", "skill-telemetry.py")
)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)


def load_records():
    out = []
    try:
        with open(DATA, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except FileNotFoundError:
        pass
    return out


def backfill():
    known = {r.get("session") for r in load_records()}
    cutoff = datetime.now() - timedelta(days=BACKFILL_DAYS)
    files = [
        p
        for p in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))
        if datetime.fromtimestamp(os.path.getmtime(p)) >= cutoff
    ]
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    added = skipped = failed = 0
    with open(DATA, "a", encoding="utf-8") as out:
        for i, path in enumerate(sorted(files)):
            session = os.path.splitext(os.path.basename(path))[0]
            if session in known:
                skipped += 1
                continue
            try:
                fields, _ = hook.extract(path, 0)
            except Exception:
                failed += 1
                continue
            if not fields["out"] and not fields["tools"]:
                skipped += 1
                continue
            record = {
                "ts": datetime.fromtimestamp(os.path.getmtime(path)).isoformat(
                    timespec="seconds"
                ),
                "session": session,
                "cwd": os.path.basename(os.path.dirname(path)),
                "backfill": True,
            }
            record.update(fields)
            out.write(json.dumps(record) + "\n")
            known.add(session)
            added += 1
            if (i + 1) % 200 == 0:
                print("...%d/%d files" % (i + 1, len(files)), flush=True)
    print(
        "backfill: %d sessions added, %d skipped, %d unparseable, window %dd"
        % (added, skipped, failed, BACKFILL_DAYS)
    )


def top(counter, n=25):
    return sorted(counter.items(), key=lambda kv: -kv[1])[:n]


def render(records):
    skills, mcp, tools, agents = {}, {}, {}, {}
    skill_last = {}
    sessions = set()
    out_tokens = 0
    for r in records:
        sessions.add(r.get("session"))
        out_tokens += r.get("out") or 0
        for s in r.get("skills") or []:
            skills[s] = skills.get(s, 0) + 1
            skill_last[s] = max(skill_last.get(s, ""), r.get("ts") or "")
        for k, v in (r.get("mcp") or {}).items():
            mcp[k] = mcp.get(k, 0) + v
        for k, v in (r.get("tools") or {}).items():
            tools[k] = tools.get(k, 0) + v
        for a in r.get("agents") or []:
            key = "%s · %s" % (a.get("type", "?"), a.get("model", "inherit"))
            agents[key] = agents.get(key, 0) + 1

    installed = (
        {
            d
            for d in os.listdir(SKILLS_DIR)
            if os.path.isdir(os.path.join(SKILLS_DIR, d)) and not d.startswith(".")
        }
        if os.path.isdir(SKILLS_DIR)
        else set()
    )
    used_bases = {s.split(":")[-1] for s in skills}
    never_used = sorted(installed - used_bases)

    def table(pairs, cols, extra=None):
        rows = (
            "".join(
                "<tr><td>%s</td><td class='num'>%d</td>%s</tr>"
                % (
                    escape(str(k)),
                    v,
                    ("<td class='muted'>%s</td>" % escape(extra(k))) if extra else "",
                )
                for k, v in pairs
            )
            or "<tr><td class='muted'>no data yet</td></tr>"
        )
        head = "".join("<th>%s</th>" % c for c in cols)
        return "<div class='tablewrap'><table><tr>%s</tr>%s</table></div>" % (
            head,
            rows,
        )

    def tile(label, value, sub):
        return (
            "<div class='tile'><div class='tile-label'>%s</div>"
            "<div class='tile-value'>%s</div><div class='tile-sub'>%s</div></div>"
            % (escape(label), escape(str(value)), escape(sub))
        )

    tiles = (
        tile("Sessions", len(sessions), "last %d days + live" % BACKFILL_DAYS)
        + tile(
            "Output tokens", "%.1fM" % (out_tokens / 1e6), "across recorded sessions"
        )
        + tile(
            "Distinct skills used",
            len(skills),
            "%d installed never used" % len(never_used),
        )
        + tile("Subagent spawns", sum(agents.values()), "by type · model below")
    )
    never_html = (
        "<p class='muted'>Installed but never used: %s</p>"
        % escape(", ".join(never_used))
        if never_used
        else ""
    )
    generated = datetime.now().strftime("%a %b %d, %Y %H:%M")
    return """<title>Skill Telemetry</title>
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
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:20px; }
  .tile { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:14px 16px; }
  .tile-label { color:var(--ink2); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .tile-value { font-size:30px; font-weight:650; margin:4px 0 2px; }
  .tile-sub { color:var(--muted); font-size:12px; }
  section { background:var(--surface); border:1px solid var(--ring); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  h2 { font-size:14px; margin:0 0 10px; color:var(--ink2); text-transform:uppercase; letter-spacing:.04em; }
  .tablewrap { overflow-x:auto; } table { width:100%%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:12px; color:var(--muted); font-weight:600; padding:0 10px 4px 0; }
  td { padding:6px 10px 6px 0; border-top:1px solid var(--grid); }
  td.num { font-variant-numeric:tabular-nums; } .muted { color:var(--muted); font-size:13px; }
</style>
<div class="wrap">
  <h1>Skill Telemetry</h1>
  <div class="stamp">Generated %s · data: telemetry/skill-usage.jsonl</div>
  <div class="tiles">%s</div>
  <section><h2>Skills by invocation</h2>%s%s</section>
  <section><h2>Subagent spawns (type · model)</h2>%s</section>
  <section><h2>MCP servers by call volume</h2>%s</section>
  <section><h2>Top tools</h2>%s</section>
</div>
""" % (
        escape(generated),
        tiles,
        table(
            top(skills),
            ["skill", "uses", "last used"],
            extra=lambda k: (skill_last.get(k) or "")[:10],
        ),
        never_html,
        table(top(agents), ["type · model", "spawns"]),
        table(top(mcp), ["server", "calls"]),
        table(top(tools, 15), ["tool", "calls"]),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    args = ap.parse_args()
    if args.backfill:
        backfill()
    records = load_records()
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "skills.html"), "w", encoding="utf-8") as f:
        f.write(render(records))
    print(
        "panel: %s (%d records)" % (os.path.join(OUT_DIR, "skills.html"), len(records))
    )


if __name__ == "__main__":
    main()
