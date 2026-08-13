#!/usr/bin/env python3
"""
Auto-sync the DashClaw main checkout to origin/main after worktree work lands.

THE PROBLEM THIS SOLVES
  When you work in a git worktree (…/.claude/worktrees/<name>) and push to
  origin/main, the MAIN checkout's files at C:/Projects/DashClaw do NOT update —
  they stay on the old commit until someone runs `git pull` there. So your
  project root silently shows older files than what's actually on main.

WHAT THIS DOES
  On Stop (end of an assistant turn), fast-forward the main checkout to
  origin/main — but ONLY when it is completely safe:
    * the repo is DashClaw (no-op everywhere else),
    * the main checkout is on the `main` branch,
    * origin/main is strictly AHEAD of the checkout's main (a real fast-forward,
      never a divergence), and
    * the checkout's tracked working tree is clean (no staged/unstaged edits).
  It is FF-only + clean-gated: it never merges, rebases, stashes, resets, or
  overwrites uncommitted work. If anything is unsafe it does nothing.

  No network call — it compares refs that a same-machine push already updated in
  the shared .git, so it's a few cheap git calls per Stop. Fail-silent; never
  blocks the turn (always exits 0).
"""

import subprocess
import sys

REPO_MARKER = "dashclaw"  # only act on the DashClaw repo; no-op elsewhere


def git(args, cwd=None):
    try:
        return subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10
        )
    except Exception:
        return None


def main():
    # The main worktree is always the FIRST entry of `git worktree list`.
    wt = git(["worktree", "list", "--porcelain"])
    if not wt or wt.returncode != 0:
        return
    main_wt = None
    for line in wt.stdout.splitlines():
        if line.startswith("worktree "):
            main_wt = line[len("worktree ") :].strip()
            break
    if not main_wt:
        return

    # Scope to DashClaw so this is a guaranteed no-op in every other project.
    if REPO_MARKER not in main_wt.replace("\\", "/").lower():
        return

    # The main checkout must be sitting on `main`.
    head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=main_wt)
    if not head or head.returncode != 0 or head.stdout.strip() != "main":
        return

    local = git(["rev-parse", "main"], cwd=main_wt)
    remote = git(["rev-parse", "origin/main"], cwd=main_wt)
    if not local or not remote or local.returncode != 0 or remote.returncode != 0:
        return
    local_sha, remote_sha = local.stdout.strip(), remote.stdout.strip()
    if not local_sha or not remote_sha or local_sha == remote_sha:
        return  # already in sync (or no refs) — nothing to do

    # Fast-forward only: origin/main must be a descendant of the checkout's main.
    anc = git(["merge-base", "--is-ancestor", "main", "origin/main"], cwd=main_wt)
    if not anc or anc.returncode != 0:
        return  # diverged — refuse to touch it (never clobber)

    # Working tree must be clean of TRACKED changes (untracked build dirs are ok).
    status = git(["status", "--porcelain", "--untracked-files=no"], cwd=main_wt)
    if status is None or status.stdout.strip():
        return  # uncommitted work in the root — leave it alone

    ff = git(["merge", "--ff-only", "origin/main"], cwd=main_wt)
    if ff and ff.returncode == 0:
        sys.stderr.write(
            "[sync-main] %s fast-forwarded to origin/main (%s)\n"
            % (main_wt, remote_sha[:8])
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
