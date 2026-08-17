# gates

Mechanical checks over the harness's own docs, hooks, and skills. Zero
dependencies, one file, one function per check.

```bash
node ~/.claude/tools/gates/gates.cjs              # everything
node ~/.claude/tools/gates/gates.cjs md-links     # one check
node ~/.claude/tools/gates/gates.cjs --list       # check ids
node ~/.claude/tools/gates/gates.cjs --report     # write + open the HTML report
node ~/.claude/tools/gates/gates.cjs --strict     # advisory checks fail too
```

Checks always scan the full standing-doc set, never only what is staged: a
rename in one doc breaks a link in another, and a staged-only scan misses
exactly that.

## The reference ratchet

`md-links` proves the pointers that exist still resolve. It cannot prove a
pointer that *used to* exist still does — so relocating a section can silently
drop one while every gate stays green. `references.json` records every path the
standing docs point at, and `ref-ratchet` fails when one of them is referenced
nowhere any more.

The set is global, not per-doc. Moving a pointer from `CLAUDE.md` into a linked
file is the index pattern working, and the gate stays green. Losing it
everywhere is a loss, and the gate goes red. Both directions are covered by the
proofs below.

When a removal is deliberate:

```bash
node ~/.claude/tools/gates/gates.cjs --accept-refs   # then review the diff
```

The pre-commit hook runs `--accept-refs` after the gates pass, so a pointer
added in a commit is under the ratchet from that commit onward.

**Never mirror `references.json` publicly.** It is an inventory of every path
these docs point at, including private project names and machine paths
(`C:/Projects/...`, `~/clawd/agent-comms/...`). Fine in this private repo;
exclude it from any public mirror sweep.

Exit 0 all green, 1 a check failed, 2 the runner broke.

## Checks

| id | Fails when |
|---|---|
| `doc-budgets` | A standing doc exceeds its `budgets.json` ceiling, or a budgeted file is gone |
| `md-links` | A backticked path or markdown link in a standing doc does not resolve |
| `ref-ratchet` | A path the docs used to point at is referenced nowhere any more |
| `note-format` | A decision note breaks the format in `docs/decision-notes.md` |
| `rule-expiry` | An `<!-- expires: YYYY-MM-DD -->` marker is past due |
| `skill-metadata` | A `SKILL.md` has no frontmatter, a name that misses its directory, or no description |
| `hook-wiring` | A `settings.json` hook points at a file that does not exist |
| `slop` | A doc trips the slop checklist. **Advisory** — reports, never blocks, unless `--strict` |

## Where it runs

The global pre-commit hook runs `doc-budgets md-links note-format rule-expiry`
when a `.md` or `settings.json` is staged **inside `~/.claude`**. Everywhere
else it is a no-op. Bypass with `git commit --no-verify`.

## Adding a check

Write a function returning `{ ok, lines, advisory? }` and add one row to
`CHECKS`. Then prove it goes red on purpose before trusting it:

```bash
node ~/.claude/tools/prove/prove.cjs \
  --check "node ~/.claude/tools/gates/gates.cjs <id>" --cwd ~/.claude \
  --file <a file the check reads> --find "<good text>" --replace "<broken text>"
```

All seven shipped checks were proved this way. A check never observed failing
has been run, not verified (L1).

## Not covered, on purpose

Dead-code and clone detection (`knip`, `jscpd`) need `node_modules`, and every
tool in `~/.claude` is zero-dependency by convention. `hook-wiring`'s orphan
report covers the failure that actually happens here — a guard nothing invokes.

Rationale and rejected alternatives:
[docs/decisions/process/2026-08-17-mechanical-harness-gates.md](../../docs/decisions/process/2026-08-17-mechanical-harness-gates.md).
