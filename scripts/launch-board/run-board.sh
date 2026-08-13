#!/usr/bin/env bash
# Launch Readiness Board — Task Scheduler ONLOGON background server.
set -a; source "C:/Users/sandm/.claude/.secrets.env"; set +a
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
python "C:/Users/sandm/.claude/scripts/launch-board/launchboard.py" \
  >> "C:/Users/sandm/.claude/scripts/launch-board/run.log" 2>&1
