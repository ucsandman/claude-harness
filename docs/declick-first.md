# declick first — the token rule and its hook

Standing rule in `CLAUDE.md` (ALWAYS block) and the compiled working agreement
(How to Work): reach for a declick adapter before an MCP tool, WebFetch, a
browser read, a screenshot or raw curl. This file holds the reasoning, the
inventory, and the mechanism. Added 2026-09-03 at Wes's request.

## Why

rtk trims what a command prints; declick trims what a *tool result* would have
been. An MCP tool result, a WebFetch of a page, or a Chrome `read_page` lands in
context whole and is re-read at cache price every later turn. The same question
through an adapter is `declick run <name> <verb> --fields a,b --limit N`: only
the fields asked for, only N rows, one JSON envelope. Adapters live in
`~/.declick/<name>/` and each one drops a SKILL.md into every client's skills
dir, so the model sees them without a tool schema being loaded.

Lean subagents (`haiku-scout`, `sonnet-implementer`, `opus-owner`) have no MCP
at all, so declick is their only road to those servers. That removes the last
routine reason to spawn `general-purpose` (about 24k tokens more per spawn). The
DECLICK-FIRST block in the `dispatch-blocks` skill goes into every brief that
reads outside the repo.

## The order

1. `declick list` — what exists.
2. `declick describe <name> --verb <v>` — flags, auth, returns, under 500 tokens.
3. `declick run <name> <verb> … --fields a,b --limit N` — trimmed JSON, exit 0 ok.

A page's links, buttons and inputs: `declick web tree <url> --selector <css> --limit 20`.
Whether a page says X: `curl -s <url> | grep -c X` (rtk trims it). WebFetch only
for prose that needs summarising. A native window: `declick desk tree <title>
--interactive`; `declick desk read <title> "<Type:Name>"` for one value. A
screenshot only for a layout or canvas question.

A target with no adapter that will be hit more than once gets one first:
`declick add <spec.json|mcp:…|graphql:…|cli:…> --name <n>`. Never edit
`~/.declick` by hand; `declick remove`, `declick build`, `declick skill`.

## Inventory (2026-09-03)

| Adapter | Engine | Replaces |
|---|---|---|
| `ghcli`, `github` | cli, openapi | `gh` calls, GitHub REST |
| `c7` | mcp (http) | the context7 plugin's MCP tools |
| `xapi` | mcp (stdio) | the `xapi` MCP server |
| `offlocal` | mcp (stdio) | the `offlocal` MCP server |
| `dashclaw-mcp` | mcp (stdio) | the `dashclaw-local` MCP server |
| `wx`, `ov`, `countries`, `fs`, `crm` | openapi, graphql, mcp, sqlite | demo builds from the launch session |

`treg` stays on its own CLI: its MCP is OAuth and declick's http engine wants a
bearer token, and the treg CLI already returns JSON. `sidetap` (the phone) is
stateful and stays MCP.

## declick-nudge.cjs

PreToolUse on `mcp__.*|WebFetch`. Advisory, never blocks. When the call's
target has an adapter (`mcp__<server>__<tool>` with
`~/.declick/<adapter>/manifest.json` on disk, server renames in the script's
map; any WebFetch; a Chrome read such as `read_page`, `computer`,
`get_page_text`, `find`, `navigate`), it injects one line naming the adapter
and the verb, for example `declick run xapi search-news --fields … --limit …`.
Once per adapter per session, then silent, so the reminder costs less than one
raw result. `DECLICK_NUDGE_OFF=1` disables.

Probe: `hooks/tests/declick-nudge-probe.cjs`, 11 cases including the silent
ones (unknown server, a Chrome click, the off switch, a bad payload). It builds
a fake `~/.declick` via `DECLICK_HOME`, so it does not depend on which adapters
this box has.

Why a hook: the rule sat in prose and the model kept reaching for the MCP tool
it could see in its listing.
