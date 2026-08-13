#!/usr/bin/env bash
# Fleet briefing daily runner — invoked by Windows Task Scheduler (6:57am).
# Loads the machine secrets (Task Scheduler starts with a bare env), runs the
# collector + SMS, then republishes the board artifact at its stable URL via a
# small headless Claude session. The python step is independent of the claude
# step so SMS/board data still land if the artifact republish fails.

set -a; source "C:/Users/sandm/.claude/.secrets.env"; set +a
# The secrets file carries an ANTHROPIC_API_KEY that would override the
# claude.ai login (and bill the API) — the headless republish must NOT use it.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

DIR="C:/Users/sandm/.claude/scripts/fleet-briefing"
LOG="$DIR/out/run.log"
mkdir -p "$DIR/out"

{
  echo "=== run $(date '+%Y-%m-%d %H:%M:%S') ==="
  python "$DIR/briefing.py" --sms --email
  echo "=== done rc=$? ==="
} >> "$LOG" 2>&1
