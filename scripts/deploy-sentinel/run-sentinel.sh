#!/usr/bin/env bash
# Deploy Sentinel runner — invoked by Windows Task Scheduler every 30 min.
set -a; source "C:/Users/sandm/.claude/.secrets.env"; set +a
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

DIR="C:/Users/sandm/.claude/scripts/deploy-sentinel"
mkdir -p "$DIR/out"
{
  echo "=== poll $(date '+%Y-%m-%d %H:%M:%S') ==="
  python "$DIR/sentinel.py"
} >> "$DIR/out/run.log" 2>&1
