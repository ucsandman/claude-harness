# Launch Readiness Board

Local web console at **http://localhost:4747** — per-project launch readiness
across the active Vercel fleet (auto-discovered, last 45 days), with clickable
per-project Re-check and Check-all buttons.

Checks: latest prod deployment READY · production domains answer <400 ·
latest GitHub Actions run green (repo matched by name heuristic;
override in `config.json` → `{"repo_map": {"vercel-project": "owner/repo"},
"exclude": [...]}`).

## Run / autostart

Autostarts at logon via `launch-board.cmd` in the user Startup folder
(shell:startup). Manual: `run-board.sh` (sources `~/.claude/.secrets.env`).
Log: `run.log`. Kill: find the PID on port 4747.

## Phase 2 (planned)

offlocal's `preflight_launch` / `verify_launch` as an extra column once its
project/environment/mapping registry is populated (provider tokens were wired
into C:/Projects/offlocalai-mcp/.env on 2026-07-11; the MCP server picks them
up on next session/reconnect).
