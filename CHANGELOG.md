# Changelog

Syncs from the private harness to this mirror. Dates are sync dates; the
underlying changes usually landed over the preceding days.

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

## 2026-08-17

- Tools: `errorlog`, `gates`, `skillfind`.
- Guards: `output-secret-watch`, `no-auto-compact`, `guard-canary`,
  `correction-tracker`, `repeat-tool-guard`, `bg-test-guard`; updated
  pre-commit chain.
- Scheduled-task installer (since retired).

## 2026-08-13

- First publish. Fresh history, not a fork of the private repo. Swept file by
  file and through full history patterns before going public.
