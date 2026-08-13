#!/usr/bin/env python3
"""SessionStart hook: warn when several Claude Code sessions are running at once.

All sessions share ONE rate limit and each re-processes its own full context, so
running 4 at once is ~4x the input cost. Heuristic: count session transcripts
(*.jsonl) under ~/.claude/projects modified within the last WINDOW_SEC seconds.

Fail-safe by design: any error -> no output, exit 0 (never break / delay startup).
"""

import json
import sys
import time
from pathlib import Path

THRESHOLD = (
    4  # warn at >= this many concurrent sessions (matches the "4+" usage signal)
)
WINDOW_SEC = 120  # a transcript touched within this window counts as "active"


def main() -> None:
    try:
        sys.stdin.read()  # drain stdin (unused); ignore if absent
    except Exception:
        pass

    projects = Path.home() / ".claude" / "projects"
    if not projects.is_dir():
        return

    now = time.time()
    active = 0
    try:
        for jsonl in projects.rglob("*.jsonl"):
            try:
                if now - jsonl.stat().st_mtime <= WINDOW_SEC:
                    active += 1
            except OSError:
                continue
    except Exception:
        return

    if active >= THRESHOLD:
        msg = (
            f"[session-budget] ~{active} Claude Code sessions look active right now "
            "(this one likely included). They share ONE rate limit and each re-processes "
            "its own full context, so running several at once multiplies token cost. "
            "If they don't need to run simultaneously, mention to Wes once that queueing "
            "them would spend the limit more evenly."
        )
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "SessionStart",
                        "additionalContext": msg,
                    }
                }
            )
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-safe: never disrupt session start
