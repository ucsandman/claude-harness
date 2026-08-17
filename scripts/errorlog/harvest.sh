#!/usr/bin/env bash
# Claude's daily error log harvest — invoked by Windows Task Scheduler (6:22am).
# Runs BEFORE NightlyMeditation (6:40am) on purpose, so the meditation session
# reads a freshly harvested log rather than yesterday's.
#
# Pure Node, no Claude session: this costs nothing and cannot die on a usage
# limit. NightlyMeditation did exactly that on 2026-08-16 (Sunday -> fable ->
# "You've reached your Fable 5 limit"), which is the failure mode this avoids.

DIR="C:/Users/sandm/.claude/scripts/errorlog"
TOOL="C:/Users/sandm/.claude/tools/errorlog"
LOG="$DIR/out/harvest.log"
mkdir -p "$DIR/out"

{
  echo "=== run $(date '+%Y-%m-%d %H:%M:%S') ==="
  node "$TOOL/errorlog.cjs" --days 1
  RC=$?
  echo "=== done rc=$RC ==="

  # A harvest that writes no HTML is a broken harvest even at rc=0. Check the
  # artifact, not the exit code — the lesson from the meditation runner, whose
  # first live run returned 0 having written nothing at all.
  if [ -z "$(find "$TOOL/errorlog.html" -mmin -180 2>/dev/null)" ]; then
    echo "HARVEST FAILED: errorlog.html missing or stale"
    exit 1
  fi
  [ "$RC" -ne 0 ] && exit "$RC"
  echo "=== artifact ok ==="
} >> "$LOG" 2>&1
