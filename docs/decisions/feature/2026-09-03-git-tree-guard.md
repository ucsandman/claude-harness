# Decision: git-tree guard

Status: implemented

## Problem

A working tree that several agents edit at once is shared mutable state. On
2026-09-03, in a 17-agent fix-findings workflow on declick, a reviewer ran
`git stash` to watch a regression test fail without the fix. Its `git stash pop`
conflicted on a sibling agent's edit to the same file, git kept the stash, and
the whole first fix pass (25 files) sat reverted under six concurrent agents for
an hour. Reconciliation meant classifying every stashed file against HEAD and
the stash, restoring sixteen and three-way merging four by hand.

The rule "never stash or checkout in a shared tree" existed as prose in the
dispatch blocks. The reviewer had not read it, and nothing enforced it.

## Decision

`hooks/git-tree-guard.cjs` runs on `PreToolUse` for Bash. It denies git
commands that rewrite a working tree other agents may be editing: `git stash`
(push, pop, apply, drop), `git checkout` or `git restore` of paths,
`git reset --hard|--merge|--keep`, `git clean`, `git switch --discard-changes`.
Reads pass (`status`, `diff`, `log`, `show`, `stash list`, `stash show`), so do
branch creation and commits. Only a git invocation in command position counts,
so a commit message or an echo that mentions the words is not a hit.

Override for a deliberate solo-session use: `# GIT_TREE_OK: <why>`, logged to
`~/.claude/logs/git-tree-guard.log`.

The prompt side of the same fix: `workflows/fix-findings.js` injects a SHARED
WORKING TREE block into every fixer, reviewer and verify prompt, and the
REVERT-TO-RED dispatch block names the mechanism for a red run: copy the pre-fix
file out with `git show HEAD:<path> > <scratchpad>/<name>` and test against the
copy. The hook is the backstop for agents that did not read either.

Self-test: 18 cases (stash forms, path checkouts, restore, reset, clean, an
env-prefixed and a sudo-prefixed stash, a parenthesized subshell, plus prose
mentions and a branch checkout that must pass). Re-run them whenever the regex
changes; the first version denied its own author's `printf` because the text
contained the words.

## Alternatives considered

**Prose only, in the dispatch blocks.** Rejected: that was the status quo that
failed. A block an agent did not read enforces nothing.

**Deny every git write in subagents.** Rejected: commits and branch creation are
how a coordinator collects work, and a fixer that cannot commit its own slice
pushes the merge burden back onto the main loop.

**Detect the shared tree and deny only then.** Rejected for now: the hook cannot
see how many agents share a checkout, and a false positive costs one override
marker while a false negative cost an hour of reconciliation.

## Consequences

- A solo session that wants a stash types the override marker; the log shows
  how often that happens, which is the evidence for narrowing the guard later.
- The regex is the risk. Any change to it re-runs the 18 cases first.
- `docs/harness-guards.md` keeps the one-paragraph summary and points here.
