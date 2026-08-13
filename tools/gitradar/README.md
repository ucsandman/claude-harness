# gitradar

Status board of every git repo on this machine.

## Why it exists

A six-repo git sweep once reported "0 commits in 24h" across repos that had
27, because `git -C` was fed MSYS-style paths (`/c/Projects/foo`) and stderr
was suppressed — git silently failed on every repo and the failure read as
"nothing happened" instead of an error. Separately, a standing rule says
"verified commits get pushed immediately," but nothing on this machine checks
whether that actually happened. `gitradar` scans every repo and makes both
failures visible: a failing git command always renders as a loud ERROR row
with the real stderr text (never as zeros), and unpushed commits get their
own counted, sorted column.

## Usage

```
node gitradar.cjs            # scan, write gitradar.html, print terminal board + summary
node gitradar.cjs --open     # also open gitradar.html in the default browser
```

Output: `gitradar.html` in this directory (generated — do not hand-edit, see
`.gitignore`).

Exit code: `0` even when repos have findings (dirty, unpushed, gone branches,
per-repo ERROR rows) — findings are the point of the tool, not a failure of
it. Exit `1` only if the scan itself cannot run at all.

## What gets scanned

Every immediate subdirectory of `C:\Projects\` that contains a `.git`, plus
`C:\Users\sandm\.claude` itself.

## Per repo

Run via `child_process.spawnSync('git', ['-C', repoPath, ...args])` — always
a native Windows path (`C:\Projects\foo`), never an MSYS path (`/c/...`) or a
`~` path. No shell is used, so there's no MSYS path rewriting to trip over —
that mismatch is the founding bug above.

- **branch** — `git -C <path> rev-parse --abbrev-ref HEAD`
- **dirty count** — number of non-empty lines from `git -C <path> status --porcelain`
- **unpushed commits** — `git -C <path> rev-list --count @{u}..HEAD`. If the
  repo has no upstream, this command fails with a "no upstream" message; that
  case renders as its own **no-upstream** warning state, not as zero.
- **gone branches** — lines in `git -C <path> branch -vv` containing `: gone]`
- **last commit age** — `git -C <path> log -1 --format=%ct`, formatted relative to now

## Failure handling — the whole point of the tool

stderr is never suppressed and never discarded. Every git call captures
`stdout`, `stderr`, and the exit code explicitly. If any command other than
the upstream check fails, or the upstream check fails for a reason other than
"no upstream," the repo renders as a red **ERROR** row showing the real
stderr text — never as zeros or a silently skipped repo.

## Output

**Terminal:** one line per repo — name, branch, dirty/unpushed/gone counts,
last-commit age — with `[OK]` / `[WARN]` / `[ERROR]` tags, worst-first. Ends
with a summary line: `N repos, N dirty, N with unpushed, N errors`.

**`gitradar.html`:** the same data as a static, self-contained, HTML-escaped
dark-themed table, color-coded by row (clean / dirty / unpushed / no-upstream
/ gone-branches / ERROR), sorted worst-first: ERROR, then no-upstream, then
unpushed commits, then gone branches, then dirty, then clean.

## Read-only

`gitradar` never runs a git command that mutates state (no fetch, no pull, no
push, no checkout). It only reads.

## Files

- `gitradar.cjs` — the generator (zero dependencies, Node only)
- `gitradar.html` — generated output (gitignored)
- `README.md` — this file
