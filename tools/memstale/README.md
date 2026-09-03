# memstale

Provenance check for institutional memory. A memory names files, scripts and
flags that were true when it was written; recall reads them as current.
`memstale` checks every absolute path a memory mentions against the disk,
prints the volume it touched, and with `--mark` writes a `stale-since:`
frontmatter line into memories that name something gone. It never deletes:
a stale memory is still evidence of what once held.

Stores scanned: `~/.claude/projects/*/memory/*.md` and `~/.agents/memory/**/*.md`.

```
node memstale.cjs              # report: STALE memories=824 paths_checked=586 missing=62 stale_memories=47
node memstale.cjs --mark       # also write / clear stale-since markers
node memstale.cjs --json
node memstale.cjs --quiet      # summary line only
MEMSTALE_HOME=<dir> node memstale.cjs   # point the store roots elsewhere (tests)
```

Runs in the nightly `/meditate` grounding step. Not a SessionStart hook: the
count is for reflection, not for every prompt.

Skipped on purpose: URLs, env and secrets files, temp dirs, placeholders
(`...`, `x.sh`, `<slug>`), prefixes ending in `-`/`_`, drives not mounted.
`C:\Program Files\x` style paths are re-joined across spaces before checking.
A run that checks zero paths says so beside its OK (L2).

Origin: 2026-09-03, Reddit thread on harness concepts ("memory provenance and
stale-state validation"). First real run found 47 stale memories out of 824,
among them `manifest-gate.cjs`, the `ship-it` skill and `~/.mcp.json`, all
removed in earlier prunes while the memories still pointed at them.
