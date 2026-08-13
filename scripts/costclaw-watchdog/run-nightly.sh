#!/usr/bin/env bash
# CostClaw watchdog runner — Windows Task Scheduler, nightly 00:07.
set -a; source "C:/Users/sandm/.claude/.secrets.env"; set +a
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

DIR="C:/Users/sandm/.claude/scripts/costclaw-watchdog"
mkdir -p "$DIR/out"
{
  echo "=== run $(date '+%Y-%m-%d %H:%M:%S') ==="
  python "$DIR/watchdog.py"
} >> "$DIR/out/run.log" 2>&1
