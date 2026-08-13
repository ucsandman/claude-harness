# spend

Token/dollar spend ledger for Claude Code sessions. Scans local transcripts
and renders `spend.html` plus a terminal summary of tokens and estimated
dollars, per day, per model, per session.

## Why this exists

Two billing incidents ($227 claude-mem, $95 security-guidance plugin) and a
110-agent Fable fleet burn all happened with **zero cost visibility** — there
was no way to see token/dollar spend building up until the bill arrived.
`fleet` (the sibling tool) shows which sessions are active. `spend` shows
what they cost.

## Usage

```
node spend.cjs               # scan last 7 days, write spend.html, print summary
node spend.cjs --days 14     # change the window
node spend.cjs --open        # also open spend.html in the default browser
```

Output: `spend.html` in this directory (generated — do not hand-edit, see
`.gitignore`). Terminal output is one line per day (tokens in/out/cache, est
$), a total line, and a cache-hit note (`N cached / M read`).

## What counts as "in window"

A transcript file's mtime is compared to "now": only files with mtime inside
the last `--days` (default 7) are opened at all — `fs.stat` runs on every
`*.jsonl` first, and anything older is skipped before it's ever read. This
governs which **files** get opened, not which days get reported: a file
touched inside the window is read in full, and its records are bucketed by
each record's own timestamp — so a long-running session touched today but
started a week ago can still surface an older day in the per-day table.

## Data source and the usage-record shape

Transcripts live at `C:\Users\sandm\.claude\projects\<project-slug>\<session-uuid>.jsonl`.
Each line is a JSON record; assistant records carry `message.model` (e.g.
`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`) and `message.usage`:

```json
{
  "input_tokens": 2,
  "output_tokens": 511,
  "cache_read_input_tokens": 0,
  "cache_creation_input_tokens": 91104,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 91104 }
}
```

**Duplicate-line gotcha (verified against real transcripts):** Claude Code
writes one JSONL line per streamed content block (text, tool_use, etc.), and
every line for the same assistant turn repeats the same `message.id` and the
same *cumulative* `message.usage` for that turn — not a per-block delta.
Summing every line naively overcounts by 3-4x. `spend.cjs` dedupes by
comparing each record's `message.id` to the last one it accumulated, and only
adds usage on the first line of a new id. This assumes duplicate lines for one
turn are written contiguously (true in every transcript checked); the
per-file `lastMessageId` is persisted in the cache so the dedup also holds
across the byte-offset boundary between runs.

## Incremental cache

Files can exceed 100 MB, so the whole file is never loaded into memory: each
file is streamed line-by-line with `readline` over a bounded
`fs.createReadStream({start, end})`. `spend-cache.json` (gitignored) is keyed
by file path and stores `{size, mtimeMs, byteOffset, lastMessageId, perDay}`:

- **Unchanged** (same size + mtime as cached) — served entirely from cache,
  zero bytes read.
- **Grew** — read only the appended range `[byteOffset, size)`.
- **Shrank, or mtime went backwards** (rotated/truncated) — re-read from 0.

A line that fails to `JSON.parse` (e.g. the reader raced a mid-write) is
skipped, same as `fleet.cjs`'s tail reader; this is a rare, self-limited edge
case, not a design gap.

## Pricing

`PRICES` at the top of `spend.cjs` holds `$` per **million** tokens for
`opus`, `sonnet`, `haiku`, `fable`, matched against `message.model` by
substring (case-insensitive), so version-suffixed IDs still resolve. Cache
write/read costs are derived from each tier's base input rate using
Anthropic's standard multipliers (5-minute write = 1.25x, 1-hour write = 2x,
cache read = 0.1x) rather than hardcoded per-model, since Anthropic doesn't
publish those separately.

All prices are **estimates**, labeled as such in both the terminal (`~$`)
and the HTML page (disclaimer banner). A model with no tier match shows `?`
for dollars while still counting its tokens. `fable` has no published public
price — it's priced as a placeholder equal to the `opus` tier and flagged
with a badge in the HTML per-model table. Edit `PRICES` directly when real
rates are known; the cache stores raw token counts, not precomputed dollars,
so a price edit takes effect on the very next run even for fully-cached
files.

## Testing hook

`--projects-dir <path>` overrides the default scan root. It exists only for
testing the "directory not found" failure path without touching the real
default; it is not meant for routine use. Pointing it at a nonexistent path
makes `spend.cjs` exit non-zero with a clear stderr message rather than
silently reporting zeros.

## Files

- `spend.cjs` — the generator (zero dependencies, Node built-ins only)
- `spend.html` — generated output (gitignored)
- `spend-cache.json` — incremental scan cache (gitignored)
- `README.md` — this file
