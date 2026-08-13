#!/usr/bin/env python3
"""Stop hook: append one JSONL record per turn capturing which skills, agents,
MCP servers, and tools the turn used, plus token usage — the data layer for
the skill-usage telemetry panel (~/.claude/scripts/skill-telemetry/).

Incremental: a per-session byte-offset cursor means each Stop only parses the
transcript tail. Fail-silent, never blocks, always exits 0.
"""

import json
import os
import sys
import tempfile
from datetime import datetime

OUT_PATH = os.path.join(
    os.path.expanduser("~"), ".claude", "telemetry", "skill-usage.jsonl"
)


def offset_path(session_id):
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in session_id)
    return os.path.join(tempfile.gettempdir(), "skill_telemetry_offset_" + safe)


def read_offset(session_id):
    try:
        with open(offset_path(session_id), encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return 0


def write_offset(session_id, offset):
    try:
        with open(offset_path(session_id), "w", encoding="utf-8") as f:
            f.write(str(offset))
    except Exception:
        pass


def extract(transcript_path, start_offset):
    """Parse transcript from byte offset; return (record_fields, new_offset)."""
    skills, agents = [], []
    mcp, tools = {}, {}
    tokens_in = tokens_out = 0
    model = ""
    with open(transcript_path, "rb") as f:
        f.seek(start_offset)
        data = f.read()
    new_offset = start_offset + len(data)
    for line in data.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        usage = msg.get("usage") or {}
        tokens_in += usage.get("input_tokens") or 0
        tokens_out += usage.get("output_tokens") or 0
        model = msg.get("model") or model
        for block in msg.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = block.get("name") or "?"
            inp = block.get("input") or {}
            tools[name] = tools.get(name, 0) + 1
            if name == "Skill" and inp.get("skill"):
                skills.append(inp["skill"])
            elif name in ("Agent", "Task"):
                agents.append(
                    {
                        "type": inp.get("subagent_type") or "general-purpose",
                        "model": inp.get("model") or "inherit",
                    }
                )
            elif name.startswith("mcp__"):
                server = name.split("__")[1] if "__" in name else "?"
                mcp[server] = mcp.get(server, 0) + 1
    return {
        "skills": skills,
        "agents": agents,
        "mcp": mcp,
        "tools": tools,
        "in": tokens_in,
        "out": tokens_out,
        "model": model,
    }, new_offset


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8-sig").strip()
        data = json.loads(raw) if raw else {}
    except Exception:
        sys.exit(0)
    session_id = data.get("session_id") or ""
    transcript_path = data.get("transcript_path") or ""
    if not session_id or not transcript_path or not os.path.exists(transcript_path):
        sys.exit(0)
    try:
        start = read_offset(session_id)
        fields, new_offset = extract(transcript_path, start)
        if fields["out"] or fields["tools"]:
            record = {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "session": session_id,
                "cwd": os.path.basename(data.get("cwd") or "") or "?",
            }
            record.update(fields)
            os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
            with open(OUT_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        write_offset(session_id, new_offset)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
