# skillfind

Find any skill on this machine, including the ones no session can see.

## Why it exists

389 unique skills live on this machine. 211 load into a session. **178 are
invisible**: stale plugin version directories, the skills of 19 disabled
plugins, project-scoped installs that only load inside one repo,
`skills-archive`, and 16 cloned marketplaces whose plugins were never
installed. Before this tool there was no way to answer "do I already have a
skill for this?" short of a manual `find` across five directories.

It was built after rejecting a proposal for an MCP server that would install a
skill per prompt and uninstall it afterward. That design cannot work: once a
skill body is in the conversation it is billed for the rest of the session, so
uninstalling reclaims nothing, and skills live in the system prompt, so
installing mid-session breaks the prefix cache and re-bills the whole
downstream context. Finding is the real problem. Swapping is not the fix.

## Usage

```
node skillfind.cjs "<query>"          # ranked hits
node skillfind.cjs "<query>" --body   # print body (invisible skills only)
node skillfind.cjs --html [--open]    # write skillfind.html
node skillfind.cjs --refresh          # rebuild the index now
```

Output: `skillfind.html` and `index.json` in this directory (generated — do not
hand-edit, see `.gitignore`).

Exit code: `0` even when a search matches nothing — a miss is information, not
a failure of the tool. Exit `1` only if no skill root is readable at all.

## Tiers, and why `--body` behaves differently per tier

A `SKILL.md` body is instructions, not data. Printing one runs its author's
prompt. So the tier decides what you get:

- **loaded** — the skill is in every session already. `--body` prints its name
  and stops. Call the `Skill` tool instead: it loads the skill with its
  `references/`, `scripts/`, and `assets/`, which `cat` cannot do, and printing
  the body here would pay the tokens twice.
- **INVISIBLE** — on disk, not loaded. `--body` prints the file behind a header
  naming the skill, its source marketplace, its real path, and whether it is
  project-scoped. That header is a label, not containment; the protection is
  that it takes an explicit `--body` on a named skill, so it never happens
  automatically.

There is no third tier. Marketplaces that have not been added are out of scope,
and nothing here touches the network.

## What gets scanned

| Root | Tier |
|---|---|
| `~/.claude/skills` | loaded |
| `~/clawd/skills` | loaded |
| `~/.claude/plugins/cache`, under an **enabled** user-scope plugin | loaded |
| `~/.claude/plugins/cache`, everything else | INVISIBLE |
| `~/.claude/plugins/marketplaces` | INVISIBLE |
| `~/.claude/skills-archive` | INVISIBLE |

`plugins/cache` is deliberately split. It holds 778 `SKILL.md` but only 124 are
reachable; treating the whole cache as loaded was the first bug caught building
this. Tier comes from `settings.json` → `enabledPlugins` intersected with
`installed_plugins.json` → user-scope `installPath`.

Records are deduped by frontmatter `name`, preferring a loaded copy over an
invisible one and then the newest mtime. 1207 files collapse to 389;
`skill-creator` alone has 42 version copies.

## Frontmatter parsing — where the bugs were

Only the first 4096 bytes of each file are read, because bodies are never
needed to build an index and the corpus is 17.8 MB. Three rules exist because
each was a silent failure first:

1. **A 4KB read is not enough.** 8 files carry frontmatter over 4096 bytes, the
   largest 16,011. If no closing `---` is found and the read filled the buffer,
   the whole file is re-read. Without this they vanish without a word.
2. **`node_modules` is skipped.** 7 vendored `SKILL.md` live inside packages and
   are not skills of this machine.
3. **YAML has four value forms here**, and three of them broke a naive read:
   plain, quoted (3 names, 76 descriptions), block scalar `|` or `>` (38
   descriptions), and a bare key whose quoted value wraps onto the next lines
   (1). Read naively a block scalar becomes the literal string `"|"`, which
   dropped 10% of the corpus out of description search. The rendered HTML page
   caught that one; 46 passing tests did not.

## Failure handling

Every skip is counted and surfaced, never silent. Unreadable files and
unparseable frontmatter use distinct sentinels so one bad file is never counted
twice, and stderr is never suppressed. A missing root is skipped quietly, since
`skills-archive` and `~/clawd/skills` are machine-specific.

## Performance

A full scan measured 1547 ms, too slow to pay per search, so parsed records are
cached to `index.json` with a 24h TTL. `--refresh` forces a rebuild.

## Tests

```
node tests/run.cjs
```

50 assertions, no framework, fixtures built at run time. Includes a
fail-on-purpose check (learned rule L1): the scanner is handed a reader that
throws, and the test asserts the unreadable counter actually moves. A counter
never observed counting is not verified.
