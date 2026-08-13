# deskclaw

An eye — and, when a human arms it, a hand — on the Windows desktop for Claude
Code. Stage 1 lists windows, dumps the UI Automation tree, and captures
screenshots. Stage 2 (2026-08-13) adds click, type, key, and focus, OFF by
default behind a viewer-only arm switch.

Design spec: `~/.claude/docs/superpowers/specs/2026-08-12-deskclaw-design.md`

## Why

Claude drives a browser (`agent-browser`) and an iPhone (`sidetap`) but could not see
the Windows desktop at all, so every desktop problem meant Wes pasting a screenshot.

## Verbs

`desk` is not on PATH. Invoke it by its full path, or `cd` into this directory first:

```bash
~/.claude/tools/deskclaw/desk windows              # list visible top-level windows
~/.claude/tools/deskclaw/desk snapshot Calculator  # UI Automation tree (@wN or a title substring)
~/.claude/tools/deskclaw/desk shot Calculator      # PNG of a window, written to state/shots/
~/.claude/tools/deskclaw/desk viewer [port]        # local control page, default http://localhost:4849
```

Stage 2 acting verbs (refuse with exit 4 until armed from the viewer):

```bash
~/.claude/tools/deskclaw/desk click @e18           # invoke an element from the last snapshot
~/.claude/tools/deskclaw/desk type @e10 "hello"    # set/type text into an element (audit logs length only)
~/.claude/tools/deskclaw/desk key Calculator "{ENTER}"  # raw SendKeys syntax to a window
~/.claude/tools/deskclaw/desk focus Calculator     # bring a window to the foreground
```

`desk windows` output:

```
@w1 "GitHub - Brave" (brave, 4521)
@w2 "Windows PowerShell" (WindowsTerminal, 8812)
@w3 "Calculator" (CalculatorApp, 6104)
@w4 [SKIPPED: denylisted]
@w5 "Program Manager" (explorer, 2288)
```

`desk snapshot Calculator` output (truncated):

```
@e1 Window "Calculator" [2742,360]
  @e2 Button "Minimize Calculator" [2792,360]
  @e3 Button "Maximize Calculator" [2838,360]
  @e4 Button "Close Calculator" [2884,360]
@e5 Window "Calculator" [2610,360]
  @e6 Text "Calculator" [2658,368]
  @e7 Custom "" [2610,392]
    @e8 Button "Open Navigation" [2614,398]
    @e9 Group "" [2610,400]
      @e10 Text "Display is 0" [2610,464]
      @e11 Button "Open history flyout" [2890,400]
      @e12 Group "Angle operators" [2614,512]
        @e13 Button "Degrees toggle" [2614,512]
        @e14 Button "Scientific notation" [2666,512]
      @e15 Group "Memory controls" [2614,548]
        @e16 Button "Clear all memory" [2614,548]
        @e17 Button "Memory recall" [2666,548]
        @e18 Button "Memory add" [2718,548]
        @e19 Button "Memory subtract" [2770,548]
        @e20 Button "Memory store" [2822,548]
        @e21 Button "Open memory flyout" [2876,548]
```

A full scientific Calculator tree is about 69 elements and 3,057 characters.

## Safety

This tool reads the screen, so secrets are an ordinary hazard, not an edge case.
During design, listing window titles alone surfaced an open `.env` file.

- **Denylisted windows are skipped entirely**, never redacted-and-kept. They appear as
  `@w4 [SKIPPED: denylisted]` with no title text. Patterns live in `deny.txt`, one per
  line, substring match, case-insensitive, against "<title> <process>". Edit that file
  to add your own.
- **Redaction** runs over every title and element name that survives: API-key shapes,
  bearer tokens, JWTs, long hex runs, and `KEY=<long value>`.
- **Acting is disarmed by default.** `click`/`type`/`key`/`focus` refuse (exit 4)
  unless `state/ACT-ARMED` exists and is unexpired. Two ways to arm:
  `desk arm [minutes]` (CLI, auto-expires, default 30 min) or the viewer's Arm
  button (permanent until disarmed). The CLI verb was a deliberate decision on
  2026-08-13: Wes traded the viewer-only gate for "just say do X" flow. The
  expiry is the compensating control — a wedged or forgotten session disarms
  itself. An unparseable expiry counts as disarmed (fails closed). The viewer's
  STOP button also disarms, so clearing STOP later does not silently re-enable
  acting. STOP and the arm switch are checked inside the acting functions
  themselves, not just the dispatcher.
- **Acting is by identity, never by coordinate.** `click`/`type` re-resolve the
  `@eN` element by UIA RuntimeId against a fresh snapshot at act time; the
  target window's denylist status is re-checked as it is NOW. If the element is
  gone, moved, offscreen, or exposes no Invoke/Toggle/SelectionItem pattern,
  the verb refuses — there is deliberately no click-where-it-was fallback
  (snapshots store a point, not a rect, so there is nothing to fall back on).
  `type` falls back from ValuePattern to real keystrokes only after proving
  both window foreground and element keyboard focus; `key` sends raw SendKeys
  syntax and proves foreground first. The audit log records typed text length,
  never the text.
- **No continuous capture, ever.** One snapshot per explicit command. No watcher.
- **Screenshots go to disk.** The tool prints a path and a byte count, never image
  content.
- **STOP.** `state/STOP` blocks every verb except `viewer`. Toggle it from the viewer
  page, or `touch state/STOP` by hand. This is a tool invariant, not just dispatcher
  policy: `Get-DeskWindow`, `Get-DeskSnapshot` and `Save-DeskShot` each refuse on their
  own if STOP is set, even if something bypasses `desk.ps1` and calls the libraries
  directly.
- **A missing or empty `deny.txt` refuses to run**, exit 1, rather than silently
  reading the desktop with no denylist. The primary safety control cannot be switched
  off by deleting a file. `desk viewer` is the one exception, since it reads no
  windows.
- **Audit log.** Every invocation appends to `state/audit.jsonl`: successful
  `windows`/`snapshot`/`shot` calls (target, element or byte counts), every refusal
  (STOP-blocked, empty denylist, denylisted target, window not found, occlusion), and
  the viewer starting or its STOP toggle being set or cleared. Detail fields never
  contain a window title.
- **Timestamps in the audit log are strings, not dates.** PowerShell 7's
  `ConvertFrom-Json` silently coerces an ISO-8601 `ts` field into a `[System.DateTime]`,
  which then renders culture-specific and breaks ISO-format assertions. If you parse
  `audit.jsonl` for display or a test, check the raw JSON line, not the parsed object.

## Exit codes

| code | meaning |
|---|---|
| 4 | acting verb while disarmed. Arm from the viewer (`state/ACT-ARMED`). |
| 3 | `state/STOP` present. Takes precedence over everything. |
| 2 | window not found, denylisted, occluded by a denylisted or unclassifiable window, or tree under 5 elements (a canvas app; needs stage 3). |
| 1 | hard error, including a missing or empty `deny.txt`. |
| 0 | success. |

## Dependencies

None. PowerShell 7 reaches .NET UI Automation directly. Do not add pywinauto,
comtypes, uiautomation, or Pester — the zero-install property is deliberate.

## Not built yet

- **Stage 3 (canvas apps):** screenshot plus OCR for Unity and Blender, which expose
  no UIA tree. Gated on proving a WinRT OCR path first.
