# Changelog

Syncs from the private harness to this mirror. Dates are sync dates; the
underlying changes usually landed over the preceding days.

## 2026-09-03 (seventh sync)

- `tools/memstale/`: memory provenance check. Every absolute path a memory
  file names is checked against the disk; the verdict carries its counts
  (`memories=824 paths_checked=598 missing=63 stale_memories=48` on first run).
  `--mark` writes a `stale-since:` frontmatter line into a memory that names
  something gone and clears it when the path returns. It never deletes.
  URLs, env files, placeholders and unmounted drives are skipped; paths with
  spaces (`C:\Program Files\x`) are re-joined before checking. Runs in the
  nightly reflection grounding step, not on every prompt.
- `workflows/fix-findings.js`: a fifth phase, Converge, capped at one pass.
  After Verify, a fresh Opus reader takes the whole uncommitted diff without
  the findings list and must return zero NEW defects. Anything it finds comes
  back shaped as fix-findings input for the next call, never as a loop.
- Both came from a Reddit exchange on harness design (task-scoped writer
  isolation, memory provenance, convergence-based verification). The first
  was already covered by worktrees and scope-lock.

## 2026-09-03 (sixth sync)

- `hooks/rm-guard.cjs`: a PreToolUse gate on Bash and PowerShell that denies a
  recursive delete whose target is not the session scratchpad or a build/cache
  directory. It splits on shell separators, so `cd build; rm -rf .` is caught
  where a start-of-command permission rule is not. Override `# RM_OK: <why>`.
  Probe in `hooks/tests/rm-guard-probe.cjs` (17 cases).
- `settings.json`: Read deny on `.env`, `.env.local`, `.env.*.local`,
  `.env.production`, `.env.development`, `*.pem`, `id_rsa*`, `id_ed25519*`,
  `.git-credentials`, `.netrc`.
- Working agreement: the trifecta stop (private data, untrusted content and an
  outbound channel never share one task), "thoughts?" means discuss not do, and
  a fix loop never edits test files (also in the sonnet-implementer brief).
  Pattern source: jde-projects.com/ai-setup/running-claude-code.
- Working agreement: a harness commit has two destinations, the private config
  repo and this mirror, pushed in the same turn.

## 2026-09-03 (fifth sync)

- declick first: the working agreement, the ALWAYS block and the three lean
  agents reach for a declick adapter before an MCP tool, WebFetch, a browser read
  or a screenshot. `hooks/declick-nudge.cjs` (PreToolUse on `mcp__.*|WebFetch`,
  advisory, once per adapter per session) says so mechanically; probe in
  `hooks/tests/`. Rationale and inventory in `docs/declick-first.md`.
- `git-tree-guard`'s incident narrative moved to
  `docs/decisions/feature/2026-09-03-git-tree-guard.md`; `harness-guards.md`
  keeps the summary.
- `git-hooks/pre-commit`: the Python gate (ruff, vulture) skips `skills-archive/`,
  which holds third-party skills kept for reference.
- `windows-gotchas.md` gotcha 15: `node.exe` and POSIX `$HOME` in git hooks.

## 2026-09-03 (fourth sync)

- `fable-delegate-guard`: direct-edit budget 8 to 20 per prompt (80 to 160
  lines); a redirect to a shell variable counts as scratch when the command
  names the scratchpad; and a hands-on switch: "hands-on", "do it yourself" or
  "line by line" in a prompt suspends the guard for the session, "delegate
  again" restores it.
- `workflows/fix-findings.js`: ownership by finding (`files: [...]`), not by
  file; every fixer greps for a second implementation of the same behaviour
  first; groups a reviewer flags get one more round with widened ownership;
  the verify step runs under a timeout and reports a hang as a failure.
- Docs: `postmortem-2026-09-03-declick-launch.md`, the session that produced
  all of the above.

## 2026-09-03 (third sync)

- Guard: `capability-graph-guard` no longer caps advisor consultations (was 2
  per agent, 3 per session). A blocked consultation becomes a guess, and a
  guess costs more tokens than the advice. Counts stay in `--report`.

## 2026-09-03 (second sync)

- Guard: `git-tree-guard` denies `git stash`, path checkouts, `restore`,
  `reset --hard` and `clean` in shell calls. Born the same day: a reviewer in a
  17-agent fix workflow stashed the shared tree, the pop conflicted, and a
  25-file fix pass sat reverted under six concurrent agents. Override
  `# GIT_TREE_OK: <why>`.
- Workflows: the four saved workflow scripts are now mirrored
  (`fix-findings`, `adversarial-review`, `tournament`, `understand`).
  `fix-findings.js` injects a shared-working-tree block into every agent
  prompt: no tree-mutating git, baselines from copies.
- Docs: `harness-guards.md` gained the git-tree-guard section with the
  incident and the 18-case self-test.

## 2026-09-03

- Guards: `capability-graph-guard`, `fable-delegate-guard`, `batch-guard`,
  `slow-command-guard`, `creds-resolve`, plus the Codex and Antigravity
  adapters and five new probes. `manifest-gate` and `bg-test-guard` retired
  (their rules moved into `gates --staged` and `slow-command-guard`).
- Agents: `advisor` (always one rung above its caller), `opus-owner`.
- Tools: `tokflow` with the 2026-09-02 token audit, `harness-sync`; `gates`
  gained `--staged`.
- `CLAUDE.md` is now the generated global agreement with a short preface.
- `settings.json`: the `autoMode` trust-boundary block is stripped from the
  mirror.
- Docs: `harness-parity.md` added; all others refreshed.
- Repo: new README, `CONTRIBUTING.md`, `SECURITY.md`, this changelog, topics.
- Sweep: 156 files scanned, 3 hits, all fake keys in deskclaw's redaction
  tests.
- Later the same day: `scripts/mirror-sync.cjs` and `scripts/mirror-sweep.cjs`
  now perform the sync. The sync deletes the machine-describing
  `settings.json` block and fails if any sentinel phrase survives; the sweep
  fails on any hit outside the redaction test fixtures. The retired
  manifest-gate doc and section are gone.

## 2026-08-17

- Tools: `errorlog`, `gates`, `skillfind`.
- Guards: `output-secret-watch`, `no-auto-compact`, `guard-canary`,
  `correction-tracker`, `repeat-tool-guard`, `bg-test-guard`; updated
  pre-commit chain.
- Scheduled-task installer (since retired).

## 2026-08-13

- First publish. Fresh history, not a fork of the private repo. Swept file by
  file and through full history patterns before going public.
