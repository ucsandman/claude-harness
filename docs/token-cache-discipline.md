# Token and Cache Discipline — background and my own levers

Moved out of the always-loaded `~/.claude/CLAUDE.md` on 2026-08-11. The agent-actionable rules stayed in CLAUDE.md → Token and Context Discipline. What follows is the reasoning behind them plus the levers only I can pull at the keyboard.

## Why the ratio matters

As of 2026-06-06 my logs showed ~14.6B input tokens vs 129M output, a 113:1 ratio. Re-pull fresh totals before citing that number; usage has grown since. The point holds regardless of the exact figure: the bill is context re-processed every turn, not what the model writes.

Use the least expensive method that preserves correctness. For simple implementation work, avoid heavyweight reasoning and broad repo scans. For architecture, security, debugging, and production decisions, slow down and reason carefully.

## How the cache works

The model caches a contiguous *prefix* of the context: system prompt, tools, CLAUDE.md, then earlier messages. Each turn appends to the end and re-reads that prefix at roughly 10% of full input price.

Changing anything *earlier* in the prefix invalidates everything after it and re-bills it at full price. That is why switching model, toggling MCP servers or plugins, and editing CLAUDE.md mid-session are expensive. Do them between tasks.

Cache TTL in this setup is ~1 hour idle (the extended TTL, not the 5-minute default). If a session goes into usage overage, later requests can drop back to the 5-minute TTL.

## rtk output compression

Installed 2026-07-07. An `rtk hook claude` PreToolUse hook auto-rewrites Bash tool commands to `rtk <cmd>`, giving 60-90% token reduction on git, cargo, npm, ls, grep, and similar.

- The hook only covers the **Bash** tool. PowerShell-tool commands get no compression, so prefer Bash for dev commands.
- If compressed output hides something needed, re-run with `rtk proxy <cmd>` for raw output.
- Failed commands auto-save full output to disk (tee mode).
- Check savings with `rtk gain`.

## Levers only I can pull

The harness cannot do these:

- **Work in bursts.** Cache TTL is ~1 hour. A long walk-away means the next turn re-caches the entire context at full price. Batch turns.
- **`/clear` or start a new session between unrelated tasks.** Don't drag a 300K-token context into the next job. Within a task, keep going; don't clear mid-flow.
- **Don't fan out parallel sessions I don't need.** All sessions share one rate limit and each re-processes its *own* full context. Four at once costs roughly 4x the input. Queue them unless they truly must run together.
- **`/compact` once a session crosses ~80% context** (about 150K, where the statusline meter turns red).
- **Don't swap MCP servers or plugins mid-session.**
