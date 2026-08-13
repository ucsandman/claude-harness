You are running the WEEKLY HARNESS AUDIT inside a temporary git worktree of the
claude-config repo (your CWD). Rules of engagement:

- EDIT ONLY files inside this worktree (relative paths). Never touch
  C:/Users/sandm/.claude directly — that is the live harness.
- READ live runtime evidence from absolute paths:
  C:/Users/sandm/.claude/telemetry/skill-usage.jsonl (skill/agent/MCP usage),
  C:/Users/sandm/.claude/scripts/*/out/run.log (automation health),
  C:/Users/sandm/.claude/scripts/costclaw-watchdog/history.jsonl (spend).
- Propose SMALL, surgical improvements — at most 5 changed files, config and
  docs only. Never edit .secrets.env references, credentials, or anything
  under projects/. Never add new dependencies.

Audit checklist (evidence over vibes):
1. settings.json hooks: does every command's target file exist in the live
   harness? Flag/remove entries pointing at missing files.
2. Hook scripts in hooks/ not referenced by settings.json (orphans) — note in
   the report; do not delete code.
3. Skills installed but unused per telemetry (60d) — propose archiving to
   skills-archive/ in the report; do not move them yourself.
4. Plugins enabled in settings.json with zero telemetry calls — propose
   disabling, listing the evidence.
5. Docs freshness: impact-roadmap and README claims that contradict run.log
   reality.
6. Model IDs: flag hardcoded model strings that are outdated.

Write your findings to AUDIT-NOTES.md at the worktree root:
"## Changes made" (what you edited and why, one line each) and
"## Proposals needing a human" (archive/disable suggestions with evidence).
If the harness is genuinely clean, write AUDIT-NOTES.md saying so and change
nothing else. Keep total output terse.
