# Codex adapters

The Codex-only hook adapters that sit beside the shared guards. Guard behavior and overrides for the shared set: [harness-guards.md](harness-guards.md). How Codex loads them: [harness-parity.md](harness-parity.md).

Codex runs the shared guards from generated hooks in `~/.codex/config.toml`. Three Codex-only pieces sit beside them:

- `hooks/adapters/codex-rewrite.cjs` — PreToolUse on `Bash`. Runs `rtk hook claude`
  and re-emits its rewrite as `permissionDecision: allow` + `updatedInput`.
  `repowise-rewrite` is disabled here since 2026-09-05: `repowise` is a Store-Python
  script that does not launch inside Codex's sandboxed pwsh (exit 1, empty output,
  11 ms), so every rewritten `npm test` cost a wasted ~35k-token turn (9 of 9
  sessions that day).
  `CODEX_REWRITE_OFF=1` disables. Probe: pipe a `git status` payload, expect
  `rtk git status`.
- `hooks/adapters/codex-delegate-guard.cjs` — PreToolUse on `Bash|apply_patch|spawn_agent|wait_agent`,
  SessionStart, UserPromptSubmit. Rewrites any `wait_agent` with `timeout_ms` under
  600000 to 600000 via `updatedInput` (every wait return is a full ~34k-token turn;
  three 10s polls cost 100k on 2026-09-05), and logs every other tool name it sees
  as `seen` so the "are collab tools hookable" question is answered from data.
  Delegate-first for an astra main loop, the Codex
  twin of `fable-delegate-guard`: gated on the `model` field every Codex hook payload
  carries, so sol/terra/luna children run free. Denies code-writing through the shell
  outside `~/.claude`, `~/.codex`, temp; budgets `apply_patch` to 12 patches of <=120
  added lines per `turn_id`. A `spawn_agent` rule (deny an astra child unless
  `agent_type` is `advisor`) is coded but inert: Codex 0.153.4 does not route
  collaboration tools through PreToolUse (verified live 2026-09-05), so child model
  choice is AGENTS.md prose. Briefs once per session with the routing rule
  (terra default, sol for many-files/root-cause/auth, luna for lookups). Shares the
  shell classifier with the Fable guard (required from agnostic-ai). Overrides:
  `# ASTRA_OK: <why>`, "hands-on" in a prompt, `CODEX_DELEGATE_GUARD=off`.
  Log `~/.agnostic/codex-delegate-guard.jsonl`, `--report`. Probe:
  `node hooks/tests/codex-delegate-guard-probe.cjs` (25 checks, pass and fail both).
  Born 2026-09-05: 224 sessions, 33,407 shell calls, zero spawns since June.
- `hooks/codex-memory-inject.cjs` — SessionStart. Injects the project map, the named
  facts under `~/.agents/memory`, and `MEMORY.md` for the cwd's Claude project slug,
  using regular Markdown files contained within the memory roots.

`secret-guard.cjs` scans patch additions and move destinations. Placeholder matches
do not suppress later credential matches. `rm-guard.cjs` checks patch deletions.
