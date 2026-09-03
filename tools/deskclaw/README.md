# deskclaw

An eye — and, when a human arms it, a hand — on the Windows desktop for Claude
Code. Stage 1 lists windows, dumps the UI Automation tree, and captures
screenshots. Stage 2 (2026-08-13) adds click, type, key, and focus, OFF by
default behind a viewer-only arm switch. 0.3.0 (2026-09-02) adds the read side an
agent would otherwise need a screenshot for: element state as snapshot
attributes, owned popup menus, `read`, `clipboard`, a JSON tree, and the
scroll/expand/collapse/select/toggle/context/dismiss verbs behind the same arm
switch.

`desk --version` prints the version.

Design spec: `~/.claude/docs/superpowers/specs/2026-08-12-deskclaw-design.md`

## Why

Claude drives a browser (`agent-browser`) and an iPhone (`sidetap`) but could not see
the Windows desktop at all, so every desktop problem meant Wes pasting a screenshot.

## Verbs

`desk` is not on PATH. Invoke it by its full path, or `cd` into this directory first:

```bash
~/.claude/tools/deskclaw/desk --version            # print the version
~/.claude/tools/deskclaw/desk windows              # list visible top-level windows
~/.claude/tools/deskclaw/desk snapshot Calculator  # UI Automation tree (@wN or a title substring)
~/.claude/tools/deskclaw/desk --json snapshot Calculator   # the same tree as a JSON array
~/.claude/tools/deskclaw/desk read @e10            # one property of one element, default value
~/.claude/tools/deskclaw/desk read @e10 --prop text # value | name | text | toggle | selected | enabled
~/.claude/tools/deskclaw/desk clipboard get        # print the clipboard (redacted, capped at 4000 chars)
~/.claude/tools/deskclaw/desk shot Calculator      # PNG of a window, written to state/shots/
~/.claude/tools/deskclaw/desk viewer [port]        # local control page, default http://localhost:4849
```

Stage 2 acting verbs (refuse with exit 4 until armed):

```bash
~/.claude/tools/deskclaw/desk click @e18           # invoke an element from the last snapshot
~/.claude/tools/deskclaw/desk type @e10 "hello"    # set/type text into an element (audit logs length only)
~/.claude/tools/deskclaw/desk scroll @e30          # ScrollIntoView, falling back to a container page-down
~/.claude/tools/deskclaw/desk expand @e12          # open a tree node, combo box or menu
~/.claude/tools/deskclaw/desk collapse @e12        # close it again
~/.claude/tools/deskclaw/desk select @e14          # select a list item, tab or row
~/.claude/tools/deskclaw/desk toggle @e7 on        # flip a checkbox; already-on is a no-op, exit 0
~/.claude/tools/deskclaw/desk context @e18         # open the element's context menu
~/.claude/tools/deskclaw/desk dismiss              # Escape to the focused window
~/.claude/tools/deskclaw/desk clipboard set "text" # put text on the clipboard
~/.claude/tools/deskclaw/desk key Calculator "{ENTER}"  # raw SendKeys syntax to a window
~/.claude/tools/deskclaw/desk focus Calculator     # bring a window to the foreground
```

`desk windows` output — the 0.2 prefix (`@wN "Title" (process, pid)`) plus window
class, `[x,y,w,h]`, and `focused=true` on the one window that has focus. A
minimised window reports `[-32000,-32000,...]`, which is Windows telling you it
is minimised. Denylisted windows still get no detail at all: their geometry is as
much of a leak as their title.

```
@w1 "GitHub - Brave" (brave, 4521) Chrome_WidgetWin_1 [1273,0,2574,1399] focused=true
@w2 "Windows PowerShell" (WindowsTerminal, 8812) CASCADIA_HOSTING_WINDOW_CLASS [262,255,1027,703]
@w3 "Calculator" (CalculatorApp, 6104) ApplicationFrameWindow [2610,360,660,880]
@w4 [SKIPPED: denylisted]
@w5 "Program Manager" (explorer, 2288) Progman [0,0,5120,1440]
```

### Snapshot attributes

`indentation @eN Type "Name" [x,y]` is the 0.2 grammar and is unchanged. Anything
an agent would otherwise need a screenshot to see is appended AFTER the
coordinates as `key=value`, and only when it carries news:

| attribute | source | when it appears |
|---|---|---|
| `value="..."` | `ValuePattern.Current.Value`, else `TextPattern` DocumentRange text | non-empty, redacted, capped at 200 chars, whitespace collapsed |
| `toggle=on\|off\|mixed` | `TogglePattern` | the element has a Toggle pattern |
| `selected=true` | `SelectionItemPattern` | only when selected |
| `enabled=false` | `IsEnabled` | only when disabled |
| `expanded=true\|false` | `ExpandCollapsePattern` | not a leaf node |
| `offscreen=true` | `IsOffscreen` | see the offscreen note below |
| `popup="<title>"` | owned popup window | on the root element of a menu or dropdown |

A real run against a window with all of them:

```
@e1 Edit "" [2360,613] value="deskclaw-value-probe"
@e2 CheckBox "probe checkbox" [2360,653] toggle=on
@e3 ComboBox "alpha" [2360,693] value="alpha" expanded=false
  @e4 Text "" [2360,693]
  @e5 Button "Open" [2564,694]
@e6 Button "probe button" [2360,733] enabled=false
```

**Owned popups.** Menus, combo dropdowns and flyouts are separate top-level
windows, so the child walk of a window cannot reach them. `snapshot` finds the
visible top-level windows of the target's process that are either owned by it or
carry `WS_POPUP`, and appends each one's root (marked `popup="<title>"`, with an
untitled menu rendering as `popup=""`) plus its subtree. They are appended AFTER
the main tree, so every `@eN` the main window already had still points at the
same element. Popup elements record their own window handle, so `click`, `select`
and the rest re-resolve them correctly.

**Offscreen.** Offscreen elements are still skipped, exactly as in 0.2 — the
acting verbs re-resolve against the same rule, so including them would hand out
refs that refuse. They are counted instead, and the walk prints `# offscreen=N`
as its last line when it skipped any. "No Save button" and "the Save button is
offscreen" are different bugs. `offscreen=true` is carried by the elements the
walk does include, which in practice means a popup root the shell reports as
offscreen.

```
@e1 Group "..." [297,319]
  @e2 Text "..." [297,319] value="..."
# offscreen=1
```

**JSON.** `desk --json snapshot <target>` prints the same tree as
`[{ref,depth,type,name,x,y,value,toggle,selected,enabled,expanded,offscreen,popup}]`,
with absent attributes omitted rather than nulled.

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
  bearer tokens, JWTs, long hex runs, and `KEY=<long value>`. It also runs over every
  new read surface — `value=`/`popup=` attributes, `desk read`, `desk clipboard get` —
  and it runs at CAPTURE time, so `state/last-snapshot.json` and the viewer that
  renders it never hold the raw string either.
- **Password fields are never read.** An element whose UIA `IsPassword` is true (or
  cannot be determined) gets no `value=` attribute at all, and `desk read --prop value`
  returns nothing for it. This is checked before the pattern is queried, not after.
- **The clipboard is read on demand only**, capped at 4000 chars and redacted.
  `clipboard get` is read-only and needs no arm; `clipboard set` is an acting verb and
  the audit log records the length, never the text.
- **`desk read` is not arm-gated**, because reading is not acting. It still honours
  STOP, still re-resolves the element live, and still re-checks the owning window
  against the denylist as it is NOW.
- **Acting is disarmed by default.** `click`/`type`/`key`/`focus`/`scroll`/`expand`/
  `collapse`/`select`/`toggle`/`context`/`dismiss`/`clipboard set` refuse (exit 4)
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
  never the text. `scroll`, `expand`, `collapse`, `select` and `toggle` are pure
  UIA pattern calls with no coordinate anywhere; each refuses (exit 2) when the
  element does not expose the pattern it needs.
- **`desk context` is the one coordinate in the tool**, and only because Windows
  exposes no "open the context menu of this element" pattern. It is still
  identity-first: the element is re-resolved live by RuntimeId, its own live
  rectangle supplies the point, the window must prove foreground, the cursor is
  put back where it was, and an element with no usable rectangle falls back to
  Shift+F10 rather than guessing.
- **`desk toggle @eN on` is idempotent.** Already-on exits 0 without touching
  anything, so "make sure this is checked" can run twice. Tri-state checkboxes get
  at most three presses (a full cycle) and then refuse rather than loop.
- **`desk dismiss` classifies the foreground window first.** Escape goes to
  whatever has focus, so a denylisted or unclassifiable foreground window refuses
  the keystroke.
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
  contain a window title. `read` logs the property NAME and the character count,
  never the value; `clipboard` logs a character count in both directions.
- **Timestamps in the audit log are strings, not dates.** PowerShell 7's
  `ConvertFrom-Json` silently coerces an ISO-8601 `ts` field into a `[System.DateTime]`,
  which then renders culture-specific and breaks ISO-format assertions. If you parse
  `audit.jsonl` for display or a test, check the raw JSON line, not the parsed object.

## Exit codes

| code | meaning |
|---|---|
| 4 | acting verb while disarmed. Arm from the viewer (`state/ACT-ARMED`). |
| 3 | `state/STOP` present. Takes precedence over everything. |
| 2 | window or element not found, denylisted, occluded by a denylisted or unclassifiable window, element exposes no pattern the verb needs, or tree under 5 elements (a canvas app; needs stage 3). |
| 1 | hard error, including a missing or empty `deny.txt`, an unknown `--prop`, or a `toggle` state that is not `on`/`off`. |
| 0 | success, including a `toggle`/`expand`/`collapse`/`select` that was already in the requested state. |

## Dependencies

None. PowerShell 7 reaches .NET UI Automation directly. Do not add pywinauto,
comtypes, uiautomation, or Pester — the zero-install property is deliberate.

## Tests

```bash
pwsh -NoProfile -File tests/run.ps1    # stage 1 + stage 2 safety model
pwsh -NoProfile -File tests/read.ps1   # 0.3.0 read side
```

Both read the live desktop and both refuse to run while `state/STOP` is set;
`tests/read.ps1` also refuses while acting is ARMED, because everything it says
about the acting verbs is that they REFUSE. It never clicks, types or sends a
key. Anything it needs a real window for comes from `tests/probe-window.ps1`, a
WinForms window the test owns start to finish and kills by the exact PID it
launched, so no window the user opened is ever touched.

## Not built yet

- **Stage 3 (canvas apps):** screenshot plus OCR for Unity and Blender, which expose
  no UIA tree. Gated on proving a WinRT OCR path first.
