# Manifest Gate — declared-vs-actual verification at commit time

Added 2026-08-11. Lives in `~/.claude/hooks/manifest-gate.cjs`, enforced by the
global pre-commit hook at `~/.claude/git-hooks/pre-commit` (`core.hooksPath`).

That hook moved out of `~/.git-hooks` on the same date. It was version
controlled nowhere: one unbacked-up file gating every commit on the machine.
The old copy is still on disk at `~/.git-hooks/pre-commit` and is now unused;
safe to delete once you are happy with the move.

## Why it exists

Every other guard in this harness is an **input** guard:

| Guard | Controls |
|---|---|
| `secret-guard.cjs` | what gets written |
| `scope-lock.cjs` | where it gets written |
| `agent-model-guard.cjs` | which model gets spawned |
| `dashclaw_pretool.py` | whether an action is permitted |

Nothing checked the **output** side: did the agent actually do what it said it
would do. CLAUDE.md asks for that in three places (§3 Surgical Changes, the
DEVIATIONS log, "THINGS I DIDN'T TOUCH" in the summary template) and all three
were prose, enforced only by the model choosing to comply.

Second job: the manifest carries `verify` commands. The most repeated failure in
`opus-handoff.md` is claiming "done" without running anything. Declared
acceptance criteria now run automatically before the commit lands.

Stolen from a r/ClaudeCode post (2026-08-11) where the author reported that
agent quality complaints disappeared once goals became machine-checkable. Their
version is a full custom CLI; this is the ~60-line idea inside it.

## Not a duplicate of DashClaw

`dashclaw_plan_submit` is forward-looking **authorization**: it dry-runs steps
through the guard pipeline so approved actions do not interrupt a run. It takes
`action_type` and `step_goal`, never sees files, and never compares intent to
result. The manifest gate is backward-looking **verification**. Different axis.
They compose fine.

## Usage

```bash
# Arm it at the start of a task
node ~/.claude/hooks/manifest-gate.cjs set \
  --goal "Add the widget component and its docs" \
  --allow "src/**" --allow "README.md" \
  --verify "npm run typecheck"

node ~/.claude/hooks/manifest-gate.cjs status   # state + regenerate the report
node ~/.claude/hooks/manifest-gate.cjs check    # what pre-commit runs
node ~/.claude/hooks/manifest-gate.cjs clear    # disarm
```

`--allow` and `--verify` both repeat. Globs: `**` spans directory separators,
`*` and `?` do not. A bare path with no wildcard also matches everything beneath
it, so `--allow src` covers `src/a/b.ts`.

## What blocks a commit

1. A staged path that matches no `--allow` pattern. Deletions and both sides of
   a rename count, so "deleted a file you never declared" is caught.
2. Any `--verify` command exiting non-zero.

Verify commands only run once the file check passes. No point spending 30s on a
typecheck for a commit that is already rejected. The report labels them
`not run` in that case rather than pretending none were declared.

## The block message is the DEVIATIONS entry

On a block it prints the exact `set` command that would declare the off-plan
files. Running it is the deliberate act of recording a deviation, which is what
the CLAUDE.md DEVIATIONS log asks for anyway.

## Human surface

Every `check` and `status` writes a self-contained HTML report to
`~/.claude/manifests/<repo-slug>.report.html` and prints a `file://` link in the
block message. Declared goal, staged-vs-declared table, which declared paths went
untouched, verify results with output tails. Light and dark, verified rendered.

## Escape hatches

- `git commit --no-verify` bypasses everything, as before.
- `MANIFEST_GATE_SKIP=1` disables just this gate.
- No manifest armed for a repo means `check` exits 0 immediately. Opt-in by
  design, so quick one-line fixes are never slowed down.

## Failure posture: fail closed

Deliberately the opposite of `secret-guard`'s PreToolUse hook, which fails open
so a bug can never wedge the editor. A verification gate that silently passes
when it breaks is exactly the failure it was built to remove. Every failure
prints the `--no-verify` escape, so a wedge is one flag away from clearing.

## Limitations

- **Keyed by repo, not session.** A commit happens in a repo and the pre-commit
  hook receives no session id. Two agents in one repo share one manifest. Use
  `scope-lock` for that case instead; it is per-session and blocks at edit time.
- Manifests older than 7 days are swept on the next `set`.
- The glob engine is a deliberate subset. Anything fancier belongs in `--allow`
  as a directory prefix.

## Related change, same date

The global pre-commit hook used to exit early when no `.py` file was staged, so
every JS/TS repo (DashClaw, noban.gg, Practical Systems) got **zero** commit-time
checks. It now runs `secret-guard.cjs --scan-staged` over every staged file
first, whatever the language. That mode reuses the same patterns as the
PreToolUse hook but inverts two rules: a real `.env` being committed is an
automatic block (writing one is fine, committing one never is), and it fails
closed. It also covers commits the PreToolUse hook cannot see, from Codex,
another agent, or a plain terminal.
