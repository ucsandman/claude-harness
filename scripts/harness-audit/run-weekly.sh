#!/usr/bin/env bash
# Weekly harness self-audit — Task Scheduler, Mondays 05:07.
# Runs headless Claude in an ISOLATED git worktree of claude-config, commits
# any proposed config changes to a branch, and opens a PR for browser review.
# The live ~/.claude tree is never modified; merging the PR is the human gate.
set -a; source "C:/Users/sandm/.claude/.secrets.env"; set +a
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

DIR="C:/Users/sandm/.claude/scripts/harness-audit"
LOG="$DIR/run.log"
REPO="C:/Users/sandm/.claude"
BRANCH="harness-audit-$(date +%Y%m%d)"
WT="$(mktemp -d)/audit"

{
  echo "=== audit $(date '+%Y-%m-%d %H:%M:%S') branch=$BRANCH ==="
  cd "$REPO" || exit 1
  git fetch -q origin
  git worktree add -q -b "$BRANCH" "$WT" origin/main || { echo "worktree failed"; exit 1; }
  cd "$WT" || exit 1

  "$HOME/.local/bin/claude" -p "$(cat "$DIR/audit-prompt.md")" \
    --model claude-sonnet-5 \
    --allowed-tools "Read,Grep,Glob,Edit,Write" \
    --max-turns 40 > "$DIR/last-audit-output.txt" 2>&1
  echo "claude rc=$?"

  # Findings-only runs must not evaporate with the worktree: keep every report.
  mkdir -p "$DIR/reports"
  [ -f AUDIT-NOTES.md ] && cp AUDIT-NOTES.md "$DIR/reports/AUDIT-$(date +%Y%m%d).md"

  if git status --porcelain | grep -qv "AUDIT-NOTES.md"; then
    git add -A
    git -c core.hooksPath=/dev/null commit -q -m "audit: weekly harness self-audit $(date +%Y-%m-%d)" \
      -m "Automated proposal — review AUDIT-NOTES.md in the diff. Merging applies it to the live harness on next pull."
    git push -q -u origin "$BRANCH"
    gh pr create --repo ucsandman/claude-config \
      --head "$BRANCH" --base main \
      --title "Weekly harness audit $(date +%Y-%m-%d)" \
      --body-file AUDIT-NOTES.md >> "$LOG" 2>&1 \
      || gh pr create --repo ucsandman/claude-config --head "$BRANCH" --base main \
           --title "Weekly harness audit $(date +%Y-%m-%d)" --body "See AUDIT-NOTES.md in the diff."
    echo "PR opened for $BRANCH"
  else
    echo "findings-only or clean — report in reports/, no PR"
    git push -q origin --delete "$BRANCH" 2>/dev/null
  fi

  cd "$REPO"
  git worktree remove --force "$WT"
  git branch -q -D "$BRANCH" 2>/dev/null
  echo "=== done ==="
} >> "$LOG" 2>&1
