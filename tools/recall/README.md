# recall

One search across every institutional-memory store on this machine.
"Have we hit this before?" used to take 3-4 separate greps across different
stores (project memory, per-repo decision logs, the claude-mem archive).
`recall` merges them into one command with one dated, ranked answer.

## Usage

```
node recall.cjs "manifest gate"           # AND match, all terms must appear
node recall.cjs "clerk stripe" --any      # OR match
node recall.cjs "os error \d+" --re       # treat query as a regex
node recall.cjs "claude-mem" --source archive
node recall.cjs "manifest gate" --all     # uncap the terminal list (default cap: 30)
node recall.cjs "manifest gate" --open    # also open recall.html
```

Matching is always case-insensitive. `--source` restricts to one of
`memory`, `docs`, `archive`.

Output: `recall.html` in this directory (generated — do not hand-edit, see
`.gitignore`), plus a merged, ranked list on the terminal.

## Sources

1. **memory** — `C:\Users\sandm\.claude\projects\<slug>\memory\*.md`, every
   project slug. Each file's YAML frontmatter (`name`, `description`, `type`,
   `modified`) is parsed with a minimal line-based reader (not a full YAML
   parser — these files only ever use single-line frontmatter values, so a
   regex per key is enough). Frontmatter plus body is the searchable text;
   one file is one result unit.
2. **docs** — `C:\Projects\<repo>\docs\DECISIONS.md` and `ERRORS.md`, one
   directory level under `C:\Projects\`. Each `## ` heading starts a new
   result unit (heading + body until the next heading); a leading
   `YYYY-MM-DD` in the heading becomes the result's date. Files with no `## `
   headings fall back to per-line matching with 2 lines of context.
3. **archive** — `C:\Projects\archives\claude-mem-2026-08-11\data\*.jsonl`
   (`observations.jsonl`, `session-summaries.jsonl`, `user-prompts.jsonl`).
   One JSON line is one result unit; `created_at` is the date, and every
   string field on the record participates in the match (observations carry
   `title`/`subtitle`/`narrative`/`facts`/`concepts`, session summaries carry
   `request`/`investigated`/`learned`/`completed`/`next_steps`/`notes`,
   prompts carry `prompt_text`).

Any path that doesn't exist at runtime is skipped with a `note:` line on
stdout — never a crash.

## Streaming design constraint (archive)

The three archive files run from ~4 MB to ~47 MB. `observations.jsonl` alone
is 47 MB, too large to read whole and JSON.parse per record safely at scale.
`recall` streams each file with `readline` over a `fs.createReadStream`,
parses one line at a time, and skips any line that fails `JSON.parse` (a few
truncated/malformed rows exist in the wild data). No archive file is ever
buffered into memory whole.

## Ranking and output shape

Results are grouped by source priority (memory, then docs, then archive) and
sorted by date descending within each group. The terminal listing caps at 30
results with a `+N more (use --all to see everything)` line; `recall.html`
always renders every result for the query just run, grouped by source with
the matched terms highlighted.

## Hard rules

- Never opens `.secrets.env` or any `.env` / `*.env` file — every source
  sweep explicitly skips them, on top of only ever globbing `.md` and
  `.jsonl` files.
- Read-only over every source. Never writes anywhere except this directory's
  own `recall.html`.

## Files

- `recall.cjs` — the tool (zero dependencies, Node only)
- `recall.html` — generated output (gitignored)
- `README.md` — this file
