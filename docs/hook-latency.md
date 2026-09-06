# Hook latency

What each registered hook costs per event, measured, and what was done about it.
Guard behavior and overrides: [harness-guards.md](harness-guards.md).

## Pass of 2026-09-06

Every registered hook was timed three times with a real payload
(`~/.claude/tools/tokflow/` has the earlier token audit; the latency table is in
memory `harness-latency-2026-09-06`). Hooks for one event run in parallel, so an
event costs its slowest hook, not the sum. What changed:

- `correction-tracker.ps1` → `correction-tracker.cjs` (pwsh 246 ms → node 45 ms
  per prompt). Same buckets, log file and injected text. Old file in `hooks/archive/`.
- `session-count.py` → `session-count.cjs` (500 ms → ~150 ms at session start).
  Walks `projects/<slug>/*.jsonl` and `<session>/subagents/**` only, instead of
  every tool-results tree. Old file in `hooks/archive/`.
- `repowise-rewrite` removed from PreToolUse Bash|PowerShell: the repowise plugin
  has been off since 2026-09-02 and the rewrite was a 111 ms no-op on every shell
  call. Restore: re-enable the plugin, then re-add the hook.
- Not changed, with numbers: the 13 node guards on a Bash call cost ~175 ms
  together versus 46 ms for one, so a single dispatcher would save ~130 ms of
  contention, but the event's slowest hook is `dashclaw_pretool.py` at ~530 ms
  (two HTTPS round trips to the DashClaw API account for 610 of its 694 ms), so a
  dispatcher buys nothing until that changes. The Stop chime and the
  context-handoff checkpoints already run `"async": true` and do not block.
