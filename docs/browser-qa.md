# Browser & Desktop QA Playbook (token-efficient)

Read this when doing browser/desktop testing. The one-line summary lives in `~/.claude/CLAUDE.md`; the detail is here so the always-loaded prefix stays lean.

> **Principle:** agent clicking is for *discovery*. The **Playwright test is the artifact you keep.** Every time the agent clicks through something, the output should be a committed test — so the next run costs ~zero tokens.

---

## The discovery ladder (cheapest first)

1. **`npx playwright codegen <url>`** — records *your* clicks into a test. Zero tokens; the recorder does the clicking, not the model. **Default for "boring clicking."**
2. **Write the test by hand** when you already know the selectors/flow.
3. **agent-browser CLI** (installed globally 2026-07-09) — **default when the model must drive the browser AND no logged-in session of Wes's is needed.** Plain Bash calls (`agent-browser open <url>`, `snapshot -i`, `click @e2`, `fill @e5 "text"`); ref-based a11y snapshots run ~200–400 tokens vs ~12K per Playwright MCP snapshot, and zero MCP tool-schema overhead. Load usage with `agent-browser skills get core` (the `agent-browser` skill in `~/.claude/skills` triggers this). Dashboard for humans at `localhost:4848`. Also covers Electron apps (`skills get electron`). **WARNING (proven 2026-08-09): `agent-browser connect 9222` does NOT attach to Wes's running browser — it silently relaunches its OWN browser instance** (output says "relaunched browser"). It will never see Wes's cookies/logins, and Wes can't watch it. Never use agent-browser for logged-in-session work; that's rung 4. **If every command fails after ~30s with `os error 10060`, the daemon is wedged — see "When agent-browser wedges" below; it is a one-command fix, not a reason to drop down the ladder.**
4. **Debug Brave over CDP + Playwright library** — **the ONLY tool when the task needs Wes's credentials/logged-in session (his real Brave), or when Wes wants to watch.** Kill Brave with `cmd //c "taskkill /F /T /IM brave.exe"` (plain Git Bash taskkill mangles `/T` into a path — verify 0 brave processes before relaunch), relaunch `cmd //c start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --restore-last-session` (standing approval 2026-08-09), verify `http://localhost:9222/json/version`, then drive with the **Playwright library** via `chromium.connectOverCDP('http://localhost:9222')` — small one-action-per-invocation `.cjs` scripts, state lives in the browser. Playwright resolves from `C:\Projects\node_modules`; scripts outside `C:\Projects` need `NODE_PATH="C:\Projects\node_modules"`. Known limit: Stripe Checkout card fields live in isolated iframes page locators can't reach — hand those to Wes. Remind Wes to restart Brave normally when done (9222 = full browser control for any local process).
5. **Playwright MCP** — fallback only if agent-browser can't handle the flow. **Always in a subagent.**
6. **Chrome DevTools MCP** — only when something *broke* and you need console / network / performance / Lighthouse. **Always in a subagent.**
7. **Claude in Chrome extension** — last resort, only when CDP is unavailable (some origins block extension APIs anyway). Its base64 screenshots accumulate permanently in context (worst measured token offender — see claude-code#27869).

The further down the ladder, the more tokens — so stop as early as it works, and **codify the result into a Playwright test** before moving on.

---

## When agent-browser wedges (rung 3 fails for everything)

**Symptom:** every `agent-browser` command dies after ~30s with
`✗ Could not configure browser: Failed to read: ... (os error 10060)`. Or, if you
piped it through `| tail`, it looks like an infinite hang with no output at all.

**Two traps here, both proven 2026-08-11:**

1. **`| tail` hides the error.** `tail` waits for EOF and the daemon holds the pipe
   open, so you see nothing and assume a hang. It was a 30s failure the whole time.
   Diagnose with `| head` or `> file`, never `| tail`.
2. **Error 10060 is `WSAETIMEDOUT` and reads like a remote network problem. It is
   pure loopback.** Do not go hunting firewalls or proxies.

**Root cause:** agent-browser runs a daemon recorded in `~/.agent-browser/<session>.pid`
and `.port`. Its listening socket is **inherited by the Chrome child processes**. Kill
the daemon (or its Chrome) without a clean shutdown and the port stays `LISTENING`
under a PID that no longer exists. agent-browser's liveness check trusts the listening
port, so it never starts a replacement and every command connects to a socket nobody
services. **The state survives until reboot.**

**Fix, one command:**

```bash
powershell -NoProfile -File ~/.claude/scripts/agent-browser-unwedge.ps1 -Check   # diagnose; exit 1 = wedged
powershell -NoProfile -File ~/.claude/scripts/agent-browser-unwedge.ps1          # clear it
```

Tries `close --all` first (a healthy session needs zero kills and keeps its
session-restore state), then kills only processes under `~/.agent-browser\`, moves the
stale state files to a timestamped backup rather than deleting, and verifies the port
released. Other projects' named `*.config` / `*.engine` sessions are untouched.
`-Session <name>` for a non-default session, `-Force` for a healthy one.

**Prevention:** always shut down with `agent-browser close --all`. Never kill its
Chrome processes directly — that is exactly what orphans the socket.

---

## Token rules (non-negotiable — this is why we use this pattern)

- **Run both browser MCPs inside a subagent (the `Agent` tool).** The heavy a11y tree / DOM / screenshots stay in the subagent's context and are **discarded**; only a short report + a generated test return to the main thread. (This is the same failure mode that made context7 ~14% of usage — MCP results that linger in the main thread *are* the cost.)
- **Prefer Playwright MCP's accessibility tree over screenshots** — structured text, deterministic, far cheaper than images.
- **Artifacts only-on-failure** (configured below). On a pass, nothing heavy is produced or read.
- **Never read the HTML report into context.** Read the `line` reporter summary + the error message; open the screenshot/trace only if a route actually failed (and the *trace* is for the human via `npx playwright show-trace <path>`, not for the model).
- **Pipe verbose runs to a file, read failures only:** `npx playwright test --reporter=line *> test-out.txt 2>&1` then read just the failing lines.
- **One browser for a smoke, not three:** `npx playwright test --project=chromium`.
- **Disable the browser MCP servers when not doing QA.** They cost on use and their results linger. Enable for a QA session, then rely on the committed tests.

---

## Failure evidence (so failures are not vibes)

In `playwright.config.ts`:

```ts
use: {
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  screenshot: 'only-on-failure',
},
reporter: [['line'], ['html', { open: 'never' }]],
```

- `line` → concise, agent-readable stdout. `html { open: 'never' }` → report on disk for you, no focus-steal.
- Inspect a failed run: `npx playwright show-trace <trace.zip>` (Trace Viewer — for the human).

---

## The QA loop

1. **Discover** the flow (codegen → or Playwright MCP in a subagent).
2. **Codify** it as a Playwright test in `tests/`.
3. **Run** headless, read the `line` summary; on failure, pull console/network via Chrome DevTools MCP (subagent) and the trace.
4. **Review with Codex** (second reviewer): *"Review the Playwright tests in `./tests`. List user flows still untested and output test stubs for the top gaps. Static review only — don't launch a browser."*
5. **Commit** the tests. Next run is cheap and repeatable.

---

## Desktop apps

- **Electron** → Playwright's Electron support (`_electron`, marked experimental):
  ```ts
  import { _electron as electron } from 'playwright';
  const app = await electron.launch({ args: ['apps/desktop/dist/main.js'] });
  const win = await app.firstWindow();
  ```
  Electron's own docs point to Playwright for E2E. This is the fit for the `noban.gg` desktop shell (Electron renders web UI inside).
- **Native Windows GUI** (non-web dialogs, installers, OS chrome) → **deskclaw**, built 2026-08-12, `~/.claude/tools/deskclaw/` (the `deskclaw` skill carries the full contract). Read-only: `desk windows` lists what is open, `desk snapshot` dumps the UI Automation tree ref-based (~777 tokens for a dense app), `desk shot` writes a PNG to disk. Zero install — PowerShell 7 reaches .NET UI Automation directly, so **pywinauto and Appium are NOT needed and NOT installed**; do not add them. It fails closed: denylisted windows are skipped entirely, a screenshot is refused when a denylisted window overlaps the target, and `state/STOP` (Wes's toggle at `desk viewer`, http://localhost:4849) blocks every verb with exit 3. There is no click/type/key verb yet — stage 2 is unbuilt, so a task that must ACT on a native window still has no tool. Canvas apps (Unity, Blender) return an empty tree by design; use their headless paths.

---

## This repo (csgo-trading-bot)

- **Dashboard** (`apps/dashboard`, Vite/React SPA) and **marketing site** (`marketing/`, static) → standard Playwright. Start the app first (`pnpm start` / `python launch.py --dev`) or wire a `webServer` block in the config.
- **Desktop** (`apps/desktop`, Electron 37) → Playwright Electron (above).
- For a quick post-edit smoke check, the **`frontend-verify` skill** is already token-cheap (reads console errors + failed network requests first, writes page state to disk, only pulls a snapshot when a route fails). Prefer it over ad-hoc MCP clicking for "did my change break anything."

---

## Housekeeping (current state, 2026-06)

- `npm init playwright` was run in **`C:\Projects`** (the *container* dir, parent of all repos), so `package.json` / `node_modules` / `tests/` / `.github/workflows/playwright.yml` landed there as a stray `projects` package. Consider moving the Playwright setup **into the specific repo** it tests (e.g. `apps/dashboard` or the repo root) so tests are versioned with the app and the CI workflow lives in a real repo.
- MCP wiring added: **Playwright MCP** → Claude Code (project/local scope); **chrome-devtools MCP** → Codex (global) and the `chrome-devtools-mcp` plugin is enabled in `settings.json`. Pick one path per tool and keep usage subagented.
