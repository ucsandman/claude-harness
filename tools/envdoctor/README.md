# envdoctor

Read-only checkup of the secrets/env wiring on this machine. Reports NAMES
and PRESENCE only, never values.

## Why it exists

Nothing checked this wiring until now, and three incidents already happened
because of that gap:

- A User-scope `ANTHROPIC_API_KEY` let a plugin worker burn **$227**.
- `BASH_ENV` leaked secrets into a plugin hook's env, burning **$95** on a
  background Opus reviewer that shouldn't have had a key at all.
- MCP servers hold stale env after a key rotation — no automated check for
  this exists; envdoctor calls it out as a manual-verify reminder instead.
- PowerShell sessions can't see `.secrets.env` vars — that wiring is
  Bash-only (`BASH_ENV`), which surprises anyone reaching for a var from a
  PowerShell tool call.

## The hard rule

envdoctor never opens, reads, cats, streams, or parses the **contents** of
`C:\Users\sandm\.claude\.secrets.env` or any other `.env` file. Existence,
size, and mtime come from `fs.stat` only. `.env.example` files are the one
exception — they're placeholders, not secrets, so their variable **names**
may be read. No env var **value** is ever printed, logged, or written
anywhere: not the terminal, not `envdoctor.html`, not an intermediate file.

## Usage

```
node envdoctor.cjs            # run all checks, print checklist, write envdoctor.html
node envdoctor.cjs --open     # also open envdoctor.html in the default browser
```

Exit code: `0` if no check FAILs, `1` if any check FAILs.

Output: `envdoctor.html` in this directory (generated — do not hand-edit,
see `.gitignore`).

## Checks

1. **`.secrets.env` presence** — `fs.stat` on
   `C:\Users\sandm\.claude\.secrets.env`: present, size > 0, mtime shown.
   WARN if missing or empty.
2. **`BASH_ENV` wiring** — reads `settings.json` / `settings.local.json`
   (config files, not `.env`) to find how `BASH_ENV` is set, resolves the
   git-bash style path (`/c/...`) to a native Windows path, and confirms the
   target script exists. Reads that script's text (a `.sh` file, not an
   `.env` file — allowed) only to check whether it references
   `.secrets.env` by name. Also collects every `"command"` string declared
   under `hooks` in both settings files and flags any that look
   bash-invoking (contain `bash` or `.sh`). WARNs only when both are true at
   once — `BASH_ENV` sources `.secrets.env` *and* a bash-invoking hook
   command exists — since that's the concrete shape of the $95 leak, not a
   guess.
3. **User-scope Windows env vars** — spawns PowerShell to list
   `[Environment]::GetEnvironmentVariables('User').Keys` (names only).
   **FAILs** if `ANTHROPIC_API_KEY` or any name matching
   `/API_KEY|SECRET|TOKEN|PASSWORD/i` is present — the $227 incident class.
4. Same check at **Machine scope**, WARN level (Machine-scope vars are rarer
   and more deliberate, but still worth a flag).
5. **Process-env sanity** — is `ANTHROPIC_API_KEY` present in this Node
   process's own env (name-presence boolean only)? Always INFO.
6. **`.env` hygiene sweep** over `C:\Projects\<repo>\` (top level only, repos
   = dirs containing `.git`). For each repo with a top-level `.env`: is it
   gitignored (`git -C <native-windows-path> check-ignore .env` — native
   paths only, `git -C` breaks on `/c/...` style paths), and does a
   `.env.example` exist? WARN if `.env` isn't ignored, or if `.env.example`
   is missing while `.env` is present.

## Verifying the FAIL path

Check 3 has a deliberate injection point at the top of `envdoctor.cjs`:

```js
const DEBUG_INJECT_USER_NAMES = [];
```

Temporarily push a fake name (e.g. `'FAKE_TEST_API_KEY'`) into that array,
run `node envdoctor.cjs`, confirm check 3 reports FAIL and the process exits
1, then revert. This never touches the real User-scope registry — it only
feeds a synthetic name into the in-memory list that check 3 filters.

## Files

- `envdoctor.cjs` — the checker (zero dependencies, Node only)
- `envdoctor.html` — generated output (gitignored)
- `README.md` — this file
