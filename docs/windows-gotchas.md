# Windows Gotchas — the measured list

Every entry below was hit and solved from scratch at least once in recorded sessions
(session-archaeology corpus, 2026-08-14). Check this file at the FIRST Windows-flavored
tool failure, before improvising. Add new entries when a new one is solved.

## Shell and path mangling

1. **MSYS path conversion mangles flags.** Git Bash rewrites `/`-prefixed args
   (`robocopy /L`) into filesystem paths. Fix: `MSYS_NO_PATHCONV=1` for that command.
   (shard_001)
2. **The Bash tool rewrites `/c` → `C:/` inside command args.** `cmd /c exit` silently
   became `cmd C:/ exit` and looked like a tool bug. Suspect path mangling before
   debugging the target. (shard_023)
3. **Native node misreads MSYS `$HOME`.** Under Git Bash, `$HOME=/c/Users/sandm` is
   read by node as `C:\c\Users\sandm` — this silently broke the entire pre-commit
   chain. In node hooks, resolve the home dir from `USERPROFILE`, never `$HOME`.
   (shard_023)
4. **PowerShell 5.1 + native exes with embedded quotes** (schtasks, taskkill, reg,
   sc): use the stop-parsing operator `--%` with cmd-style `\"` inner quotes. Three
   failed pastes in a row before this was codified. (shard_019; also in CLAUDE.md)
5. **8191-char command-line limit.** Passing a 559KB JS file as a CLI eval argument
   fails. Serve large payloads over a local HTTP endpoint instead. (shard_001)
6. **`git rev-parse --show-toplevel` returns a Windows path, `$HOME` is POSIX.**
   `C:/Users/sandm/.claude` never equals `/c/Users/sandm/.claude`, so a hook
   gated on that comparison exits silently and looks like it passed. Normalise
   both sides with `cd "$dir" && pwd` before comparing. (2026-08-17)
7. **ESM cannot import a Windows absolute path.** Node 24 will run a repo's own
   `.ts` module directly with `--experimental-strip-types`, which is the cheapest
   way to dogfood a shipped code path instead of reimplementing it in a script.
   But `import '.../C:/Projects/...'` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`
   (the drive letter reads as a URL scheme), and a path with a space needs
   encoding too. Fix: `await import(pathToFileURL(abs).href)` from `node:url`.
   (2026-08-17)

## Process and signal semantics

6. **`timeout N` sends SIGTERM, not SIGINT.** Python's KeyboardInterrupt never fires,
   producing false-negative tests of Ctrl+C cleanup paths. Exercise interrupt handling
   via an explicit `--duration`/`--timeout` flag in the program instead. (shard_021)
7. **`Write-Error` inside `try` under `$ErrorActionPreference='Stop'` becomes a
   terminating error** and is swallowed by the enclosing `catch`. Rediscovered
   independently in two tools (deskclaw, mouth/say.ps1). Use `Write-Warning` or throw
   deliberately. (shard_023)

## Encoding and packaging

8. **Default console encoding is cp1252.** Any third-party Python script that prints
   emoji/unicode crashes on its first `print()`. Set `PYTHONIOENCODING=utf-8` (or
   `[Console]::OutputEncoding`) before running. (shard_002 — and it reproduced live
   during the archaeology build itself)
9. **Windows-native zip tools write backslash entry paths**, which Claude skill upload
   rejects as invalid. Build zips with `tar -a` or another POSIX-path-safe method.
   (shard_025)

## Testing on Windows

10. **Bind ephemeral test servers to `127.0.0.1` explicitly.** The default IPv6
    wildcard bind (`::`) made `localhost` navigation take 39+ seconds and hung a
    browser test for hours. (shard_001)
