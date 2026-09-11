#!/usr/bin/env bash
# memory-lint pre-commit step for the auto-memory store. Called from this repo's
# .git/hooks/pre-commit, which git-hooks/pre-commit chains as step 1. Runs only when
# a file under the store is staged. Tier rules: agnostic-rules.md, Memory section.
# Bypass once: git commit --no-verify.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
STORE="projects/C--Users-sandm--claude/memory"
if git diff --cached --name-only | grep -q "^$STORE/"; then
  echo "[memory-lint] checking staged memory store changes..."
  if ! node "$ROOT/tools/memory-lint/memory-lint.mjs" --root "$ROOT/$STORE" --staged --quiet; then
    echo "[memory-lint] BLOCK: fix the FAIL lines above"
    exit 1
  fi
fi
exit 0
