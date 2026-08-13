#!/usr/bin/env python3
"""UserPromptSubmit hook: once per high-context crossing, prompt Claude to advise
/compact or /clear.

Hooks cannot run slash commands, so the most we can do is nudge Claude to surface
the action to the user at the right moment. Reads the live context percentage that
statusline.ps1 publishes to a temp file keyed by session_id, and fires once per
crossing of THRESHOLD (re-arms after the context drops back below it, e.g. after a
/compact).

Fail-safe by design: any error -> no output, exit 0 (never block the user's prompt).
"""

import json
import os
import re
import sys
from pathlib import Path

THRESHOLD = 80  # percent of the context window


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return

    sid = str(data.get("session_id", "")).strip()
    if not sid:
        return

    safe = re.sub(r"[^A-Za-z0-9_-]", "_", sid)
    tmp = Path(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp")
    pct_file = tmp / f"claude_ctx_{safe}.txt"
    flag = tmp / f"claude_ctxnudge_{safe}.flag"

    try:
        pct = int(pct_file.read_text().strip())
    except Exception:
        return  # statusline hasn't published a reading for this session yet

    if pct >= THRESHOLD and not flag.exists():
        try:
            flag.write_text("1")
        except Exception:
            pass
        msg = (
            f"[context-budget] This session is at ~{pct}% of the context window. "
            "Tell Wes once, briefly: if the next task is unrelated to this thread use /clear; "
            "if continuing the same task use /compact. Long contexts are billed every turn "
            "even when cached."
        )
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": msg,
                    }
                }
            )
        )
    elif pct < THRESHOLD and flag.exists():
        try:
            flag.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-safe: never block a prompt
