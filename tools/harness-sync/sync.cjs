#!/usr/bin/env node
// RETIRED 2026-09-06. The Claude -> Codex/agy port now lives in the Agnostic-AI
// repo (C:\Projects\agnostic-ai), generalised and tested against fixture homes:
//
//   cd C:\Projects\agnostic-ai && npm run port          # capture ~/.claude, apply everywhere
//   cd C:\Projects\agnostic-ai && npm run port:check    # exit 1 on drift
//   cd C:\Projects\agnostic-ai && npm run explain       # what was not ported, and why
//
// The last version of this script is kept beside it as sync.cjs.retired-20260906
// for reference. Two writers of ~/.codex/AGENTS.md is exactly the bug that
// prompted the move, so this stub refuses to run.
console.error('harness-sync/sync.cjs is retired; run `npm run port` in C:\\Projects\\agnostic-ai instead.');
process.exit(1);
