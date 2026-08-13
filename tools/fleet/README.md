# fleet

Session monitor for Claude Code. Wes often runs ~4 sessions at once on this
machine; they share one rate limit and each re-processes its own context every
turn, but there's no surface showing which sessions are live, what each is
working on, and how heavy each is. `fleet` scans the local transcripts and
renders that surface as a local HTML page.

## Usage

```
node fleet.cjs            # scan, write fleet.html, print path + summary line
node fleet.cjs --open     # also open fleet.html in the default browser
node fleet.cjs --watch    # regenerate every 30s until Ctrl+C, heartbeat per pass
```

Output: `fleet.html` in this directory (generated — do not hand-edit, see
`.gitignore`).

## What counts as "active"

A session's transcript file's mtime is compared to "now":

- **active** (green dot) — mtime is 10 minutes ago or less
- **idle** (gray dot) — mtime is older than 10 minutes

Only sessions with mtime inside the last 24 hours appear at all; everything
older is skipped before it's ever opened.

Slugs containing `Temp` (scratchpad/temp working dirs) are marked with a
"scratch" badge.

## Data source and the tail-read design constraint

Transcripts live at `C:\Users\sandm\.claude\projects\<project-slug>\<session-uuid>.jsonl`.
There are 488+ of these files, most old, some over 100 MB. To keep `fleet.cjs`
fast and cheap:

1. `fs.stat` every `*.jsonl` first. Only files with mtime in the last 24 hours
   get read at all — old files are never opened.
2. Never read a whole file. Open with `fs.openSync` and read only the last
   ~256 KB (`fs.readSync` from `size - 262144`).
3. Split that chunk into lines, drop the first line if the read didn't start
   at byte 0 (it's a partial line), and `JSON.parse` each remaining line
   individually, skipping any line that fails to parse.

Each parsed line ("record") is a transcript event with a `type` field
(`"user"` / `"assistant"` / others), a `message` object whose `content` is
either a plain string or an array of blocks (`{type:"text", text:...}` mixed
with `tool_use` / `tool_result` blocks), and a `timestamp`. `fleet` walks the
tail records backwards to find the latest user text ("last ask") and latest
assistant text ("last reply"), skipping tool-only entries, truncates each to
200 characters, and HTML-escapes everything before it goes in the page.

## Files

- `fleet.cjs` — the generator (zero dependencies, Node only)
- `fleet.html` — generated output (gitignored)
- `README.md` — this file
