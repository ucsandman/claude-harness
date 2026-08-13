# New Project Setup

Moved out of the always-loaded `~/.claude/CLAUDE.md` on 2026-08-11. It fires rarely and taxed every session. Pointer stays in CLAUDE.md → Definition of Done.

## Scaffold

Every new project includes:

- `.env` (local only, never committed)
- `.env.example` with placeholders for every variable
- `.gitignore` covering `.env`, `node_modules/`, and build output (`dist/`)
- `README.md` with run steps
- `CLAUDE.md` describing the project

## Layout

Choose a directory layout that fits the stack. A reasonable default:

```
project/
├── src/
├── tests/
├── docs/
├── .claude/skills/
└── scripts/
```

## Architecture snapshot

The project's `CLAUDE.md` states clearly:

- What the repo does
- Its major components
- External dependencies
- Data stores
- Deployment model
- Where configuration lives

If any of that is unclear, ask once, then proceed.

## Single-command test entry

Every project gets a `launch.py` (or equivalent one-liner) that starts everything needed to run and test the project locally. No multi-step startup instructions.
