#!/usr/bin/env node
// gates.cjs — mechanical checks over the harness's own docs, hooks, and skills.
// One runner, one function per check, zero dependencies.
//
//   node gates.cjs                 run every check
//   node gates.cjs md-links slop   run named checks
//   node gates.cjs --list          list check ids
//   node gates.cjs --strict        advisory checks fail too
//   node gates.cjs --staged        pre-commit scope: only hits this commit touches block
//   node gates.cjs --report        also write and open an HTML report
//
// Exit 0 all green, 1 a check failed, 2 the runner itself broke.
// Design source: docs/decisions/process/2026-08-17-mechanical-harness-gates.md

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const BUDGETS = path.join(__dirname, 'budgets.json');
const REFS = path.join(__dirname, 'references.json');
const DECISION_CLASSES = ['architecture', 'process', 'feature', 'bug-fix', 'simplification', 'testing'];

// ─────────────────────────────────────────────────────────── helpers

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/**
 * Under --staged, a hit fails the run only when this commit touches it: the
 * offending doc is staged, or the path it points at is staged (added, deleted
 * or renamed). Every other hit prints as `warn` so unrelated uncommitted work
 * in the tree cannot block a commit (2026-09-03: another session's archived
 * hook blocked every commit for a day). Without --staged everything fails.
 */
const blocks = (ctx, ...keys) => !ctx || !ctx.staged || keys.some((k) => k && ctx.staged.has(k));

/** Repo-relative paths in the index: old and new names of renames, deletions too. */
function stagedPaths() {
  const out = execSync('git diff --cached --name-status -M', { cwd: ROOT, encoding: 'utf8' });
  const set = new Set();
  for (const line of out.split('\n')) {
    const cols = line.trim().split('\t');
    if (cols.length < 2) continue;
    for (const p of cols.slice(1)) set.add(p.replace(/\\/g, '/'));
  }
  return set;
}

/** `wc -w` equivalent: whitespace-delimited tokens. */
function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Standing docs: the prose an agent or a human is expected to trust. Feeds
 * checkSlop, checkRuleExpiry and (via livePointerDocs) checkRefRatchet.
 * Excludes docs/superpowers/ and docs/specs/ (working material, not standing
 * orders) and docs/decisions/archived/ (frozen — never edited, never gated).
 *
 * skills/<name>/SKILL.md is deliberately NOT included here (2026-09-05): those docs
 * live in the `skills` git submodule, a different repo, and widening this list
 * once fed 43 skill-derived paths into references.json on the next
 * `--accept-refs` and made checkSlop trip on skill prose it never used to see.
 * md-links alone gets the wider set — see mdLinkDocs().
 */
function standingDocs() {
  const docs = [];
  for (const name of ['CLAUDE.md', 'SOUL.md', 'RTK.md']) {
    const p = path.join(ROOT, name);
    if (exists(p)) docs.push(p);
  }
  const docsDir = path.join(ROOT, 'docs');
  if (exists(docsDir)) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) docs.push(path.join(docsDir, entry.name));
    }
  }
  for (const p of decisionNotes()) docs.push(p);
  return docs;
}

/** standingDocs() plus skills/<name>/SKILL.md — the wider set checkMdLinks alone uses. */
function mdLinkDocs() {
  return [...standingDocs(), ...skillDocs()];
}

/** Active decision notes. `archived/` is frozen and deliberately excluded. */
function decisionNotes() {
  const dir = path.join(ROOT, 'docs', 'decisions');
  return walk(dir)
    .filter((p) => p.endsWith('.md'))
    .filter((p) => !rel(p).startsWith('docs/decisions/archived/'))
    .filter((p) => path.basename(p) !== 'README.md');
}

/**
 * One level under skills/: `<name>/SKILL.md`. A skill directory can be a
 * symlink or junction (`~/.claude/skills/claude-api` → `~/.agents/skills/...`),
 * and `Dirent.isDirectory()` reports false for those on this machine, so a
 * plain dirent check silently drops them — fall back to `statSync`, which
 * follows the link. checkSkillMetadata (below) uses the identical fallback.
 */
function skillDocs() {
  const skillsDir = path.join(ROOT, 'skills');
  const docs = [];
  if (!exists(skillsDir)) return docs;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const dirPath = path.join(skillsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir) { try { isDir = fs.statSync(dirPath).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    const skillFile = path.join(dirPath, 'SKILL.md');
    if (exists(skillFile)) docs.push(skillFile);
  }
  return docs;
}

/**
 * Resolve a path reference found in prose to an absolute path.
 * Returns null for anything not checkable: URLs, anchors, globs, placeholders.
 */
function resolveRef(ref, fromFile) {
  let r = ref.trim().replace(/[.,;:)\]]+$/, '');
  if (!r) return null;
  if (/^(https?:|mailto:|#)/i.test(r)) return null;
  if (/[*?<>{}]/.test(r)) return null; // glob or placeholder, not one path
  if (r.includes('${') || r.includes('$env:')) return null;
  r = r.replace(/\\/g, '/');
  // Claude Code's own per-project MCP manifest is optional by design — a doc
  // that lists it among the locations a script scans for is describing normal
  // discovery, not a dead pointer (2026-09-05: skills/harness-health/SKILL.md
  // names `~/.claude/.mcp.json`, absent on this machine, as one such location).
  // Scoped to skills/ docs only — a standing doc naming a real .mcp.json path
  // (docs/INDEX.md's own reference) must still be checked like any other file.
  if (path.basename(r) === '.mcp.json' && rel(fromFile).startsWith('skills/')) return null;
  if (r.startsWith('~')) return path.join(HOME, r.slice(1));
  if (/^[A-Za-z]:\//.test(r)) return r;
  if (r.startsWith('/')) return null; // POSIX-absolute: not a path on this machine
  return path.resolve(path.dirname(fromFile), r);
}

/**
 * Blank out fenced code blocks, preserving line numbers. A doc that *documents*
 * a marker or a phrase in an example must not trip the gate that hunts for it.
 */
function stripFences(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  }).join('\n');
}

/**
 * Blank out backticked spans and double-quoted terms as well as fences.
 * Naming a phrase in order to forbid it is not using it — without this the
 * slop checklist in docs/doc-standard.md fails its own gate.
 */
function stripQuoted(text) {
  return stripFences(text)
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"\n]{0,80}"/g, (m) => ' '.repeat(m.length));
}

/**
 * Every path reference in a doc: markdown link targets plus backticked paths.
 * Bare prose paths are deliberately NOT scanned — too many false positives from
 * example commands. Reference a real file in a link or backticks and it is gated.
 *
 * `~`, a drive letter, or a `../` climb are unambiguous — always a candidate
 * (docs/INDEX.md's `../.secrets.env` needs exactly this; there is no directory
 * beside the doc named `.secrets.env` to check).
 *
 * A bare path (no leading dot) is accepted only when its first segment
 * already exists beside the doc. That is the one mechanical signal that
 * tells "skills/x/references/foo.md" — a real, checkable self-reference —
 * apart from "studio/src/lib/audioMix.ts", a pointer into a different
 * project the skill operates on (2026-09-05: naive widening hit 41 of them
 * across 55 skills). A path written `./` (single dot — same directory, not a
 * climb) is unconditional in a standing doc — a dead `./missing.md` in
 * docs/INDEX.md must still be caught — but inside a skill's SKILL.md gets
 * the same first-segment heuristic: `./phone-harness.cmd` reaches a script
 * only after a `cd` into a different repo's root and is never relative to
 * the skill's own directory — resolving it against skills/phone/ produced a
 * false DEAD hit until `./` got this same check there.
 */
function extractRefs(text, fromFile) {
  const refs = new Set();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) refs.add(m[1]);
  const underSkills = fromFile && rel(fromFile).startsWith('skills/');
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const v = m[1].trim();
    const absolute = /^(~|[A-Za-z]:[\\/]|\.\.[\\/])/.test(v);
    let candidate = absolute;
    if (!absolute && !underSkills && /^\.[\\/]/.test(v)) candidate = true; // `./` in a standing doc is unconditional
    if (!candidate && fromFile && !/\s/.test(v) && /[\\/]/.test(v)) {
      const stripped = v.replace(/^\.[\\/]/, ''); // strip a leading ./ only — ../ is already `absolute` above
      const first = stripped.split(/[\\/]/)[0];
      if (first && !/[*?<>{}]/.test(first) && exists(path.join(path.dirname(fromFile), first))) candidate = true;
    }
    if (!candidate) continue;
    // A file (has an extension) or an explicit directory (trailing separator).
    // A bare path with neither is ambiguous prose and is left alone.
    if (/\.[a-z0-9]{1,5}$/i.test(v) || /[\\/]$/.test(v)) refs.add(v);
  }
  return [...refs];
}

// ─────────────────────────────────────────────────────────── checks

/** Word ceilings from budgets.json. A missing budgeted file is a failure. */
function checkDocBudgets(ctx) {
  const lines = [];
  let ok = true;
  if (!exists(BUDGETS)) return { ok: false, lines: [`budgets.json missing at ${rel(BUDGETS)}`] };
  const manifest = JSON.parse(read(BUDGETS));
  for (const [relPath, ceiling] of Object.entries(manifest)) {
    if (relPath.startsWith('_')) continue; // `_comment` and friends
    const abs = path.join(ROOT, relPath);
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      lines.push(`BAD  ${relPath}: ceiling must be a positive integer, got ${ceiling}`);
      ok = false;
      continue;
    }
    if (!exists(abs)) {
      lines.push(`MISS ${relPath}: budgeted file does not exist — renamed or deleted? update budgets.json in the same change`);
      ok = false;
      continue;
    }
    const words = countWords(read(abs));
    const pct = Math.round((words / ceiling) * 100);
    if (words > ceiling) {
      const hit = `OVER ${relPath}: ${words} words exceeds the ${ceiling}-word ceiling — relocate to a linked doc first, condense second, raise the ceiling last`;
      if (blocks(ctx, relPath)) { lines.push(hit); ok = false; } else lines.push(`warn ${hit} (not staged)`);
    } else {
      lines.push(`ok   ${relPath}: ${words}/${ceiling} (${pct}%)`);
    }
  }
  return { ok, lines };
}

/**
 * Every linked or backticked path in a standing doc resolves on this machine.
 * Uses ctx.mdLinkDocs, not ctx.docs — standingDocs() plus skills/<name>/SKILL.md.
 * The wider set is scoped to this one check; see mdLinkDocs().
 */
function checkMdLinks(ctx) {
  const lines = [];
  let ok = true;
  let checked = 0;
  const docs = ctx.mdLinkDocs;
  for (const doc of docs) {
    for (const ref of extractRefs(read(doc), doc)) {
      const abs = resolveRef(ref, doc);
      if (abs === null) continue;
      checked++;
      if (!exists(abs)) {
        const hit = `DEAD ${rel(doc)} → ${ref}`;
        if (blocks(ctx, rel(doc), rel(abs))) { lines.push(hit); ok = false; } else lines.push(`warn ${hit} (neither side staged)`);
      }
    }
  }
  const skillCount = docs.filter((d) => rel(d).startsWith('skills/')).length;
  if (ok) lines.push(`ok   ${checked} references across ${docs.length} docs (skills scanned=${skillCount}) all resolve`);
  else lines.push(`      ${checked} references checked across ${docs.length} docs, skills scanned=${skillCount}`);
  return { ok, lines };
}

/**
 * The slop checklist, mechanised. Advisory: these are smells, not defects, and
 * a false positive must never block a commit. Run with --strict to enforce.
 */
const SLOP_RULES = [
  // "no longer" is deliberately absent: it legitimately describes runtime state
  // ("a PID that no longer exists"), and flagging that is a checker bug.
  { id: 'narrated-history', re: /\b(previously|used to (be|live|sit)|was moved|has been renamed|as of this writing)\b/gi,
    fix: 'state the current fact; move the story to a decision note or ERRORS.md' },
  { id: 'status-annotation', re: /\b(coming soon|not yet implemented|TODO: implement|future:|planned:)\b/gi,
    fix: 'status rots in prose; let the repo layout carry it' },
  { id: 'emphasis-inflation', re: /\b(critically|extremely important|VERY IMPORTANT|absolutely must)\b/g,
    fix: 'reserve emphasis for the clause that changes behavior' },
  { id: 'spec-speak', re: /\b(we should|it should probably|the plan is to|migration plan)\b/gi,
    fix: 'a shipped decision describes what is, in the present tense' },
];

function checkSlop(ctx) {
  const lines = [];
  let hits = 0;
  for (const doc of ctx.docs) {
    const text = stripQuoted(read(doc));
    for (const rule of SLOP_RULES) {
      const found = [...text.matchAll(rule.re)];
      if (found.length) {
        hits += found.length;
        lines.push(`${rel(doc)}: ${found.length}× ${rule.id} (${[...new Set(found.map((f) => f[0]))].slice(0, 3).join(', ')}) — ${rule.fix}`);
      }
    }
  }
  // Same rule in two homes: a distinctive sentence repeated across standing docs.
  const seen = new Map();
  for (const doc of ctx.docs) {
    for (const sentence of read(doc).split(/(?<=[.!?])\s+|\n/)) {
      const key = sentence.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
      // 12 words, not 8: a shared provenance header ("Moved out of the
      // always-loaded CLAUDE.md on 2026-08-11.") is boilerplate, not a rule
      // stated twice, and flagging it trains people to ignore the gate.
      if (key.split(' ').length < 12) continue;
      if (seen.has(key) && seen.get(key) !== doc) {
        lines.push(`DUP  "${sentence.trim().slice(0, 70)}…" appears in both ${rel(seen.get(key))} and ${rel(doc)} — keep one home, link the other`);
        hits++;
      } else seen.set(key, doc);
    }
  }
  if (!hits) lines.push(`ok   no slop patterns across ${ctx.docs.length} standing docs`);
  return { ok: hits === 0, advisory: true, lines };
}

/**
 * Decision notes follow one format: path-encoded class, dated filename, a header
 * block, `## Problem` first, and a mandatory `## Alternatives considered`.
 * A decision recorded without what it beat invites re-litigation.
 */
function checkNoteFormat() {
  const lines = [];
  let ok = true;
  const notes = decisionNotes();
  for (const note of notes) {
    const r = rel(note);
    const parts = r.split('/'); // docs/decisions/<class>/<file>
    const fail = (msg) => { lines.push(`${r}: ${msg}`); ok = false; };
    if (parts.length !== 4) {
      fail('must live at docs/decisions/<class>/yyyy-mm-dd-topic.md');
      continue;
    }
    if (!DECISION_CLASSES.includes(parts[2])) fail(`class "${parts[2]}" is not one of ${DECISION_CLASSES.join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(parts[3])) fail('filename must be yyyy-mm-dd-lowercase-topic.md');

    const text = read(note);
    const head = text.split(/\r?\n/);
    if (!/^# Decision: .+/.test(head[0] || '')) fail('line 1 must be "# Decision: <title>"');
    const status = head.find((l) => l.startsWith('Status:'));
    if (!status) fail('needs a "Status:" line in the header block');
    else if (!/^Status: (proposed|implemented|rejected — .+)$/.test(status.trim())) {
      fail('Status must be "proposed", "implemented", or "rejected — <why>"');
    }
    const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    if (sections[0] !== 'Problem') fail('the body must open with "## Problem"');
    if (!sections.includes('Alternatives considered')) fail('missing the mandatory "## Alternatives considered" section');
    if (status && status.includes('implemented')) {
      for (const banned of ['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria']) {
        if (sections.includes(banned)) fail(`"## ${banned}" is proposal-era spec-speak in an implemented note — say what shipped`);
      }
    }
  }
  if (ok) lines.push(`ok   ${notes.length} decision notes well-formed`);
  return { ok, lines };
}

/**
 * A rule that is only true for a while carries its own expiry:
 *   <!-- expires: 2026-12-01 — reason -->
 * Past the date the gate goes red, so situational rules cannot quietly become
 * permanent ones.
 */
function checkRuleExpiry(ctx) {
  const lines = [];
  let ok = true;
  let found = 0;
  const today = ctx.today;
  for (const doc of ctx.docs) {
    const text = stripFences(read(doc));
    for (const m of text.matchAll(/<!--\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*(?:[—-]\s*([^>]*?))?\s*-->/g)) {
      found++;
      const [, date, reason] = m;
      const line = text.slice(0, m.index).split('\n').length;
      if (date < today) {
        lines.push(`EXPIRED ${rel(doc)}:${line} — expired ${date}: ${(reason || '').trim() || 'no reason recorded'}`);
        ok = false;
      } else {
        lines.push(`ok      ${rel(doc)}:${line} — expires ${date}`);
      }
    }
  }
  if (!found) lines.push('ok   no expiring rules declared');
  return { ok, lines };
}

/**
 * Docs whose references are LIVE pointers — prose that tells a reader where to
 * go now. Decision notes and ERRORS.md are excluded: they cite paths while
 * recounting history, and a path named in a postmortem about losing it would
 * otherwise keep the ratchet green. (Observed 2026-08-17 on this very gate.)
 */
function livePointerDocs() {
  return standingDocs().filter((p) => {
    const r = rel(p);
    return !r.startsWith('docs/decisions/') && r !== 'docs/ERRORS.md';
  });
}

/** Every resolvable reference across the live-pointer set, as stable repo-relative keys. */
function currentRefs(docs) {
  const set = new Set();
  const rootAbs = path.resolve(ROOT).toLowerCase();
  for (const doc of docs) {
    for (const ref of extractRefs(read(doc), doc)) {
      const abs = resolveRef(ref, doc);
      if (abs === null) continue;
      const full = path.resolve(abs);
      const key = full.toLowerCase().startsWith(rootAbs) ? rel(full) : full.replace(/\\/g, '/');
      // The harness root and a bare drive root are degenerate: they can never be
      // "lost", and ratcheting on them is noise.
      if (!key || /^[A-Za-z]:\/?$/.test(key)) continue;
      set.add(key);
    }
  }
  return [...set].sort();
}

/**
 * The ratchet: a path this harness once pointed at must still be pointed at
 * from somewhere in the standing set.
 *
 * `md-links` proves the pointers that exist still resolve. Nothing proved that
 * a pointer which used to exist still does, so relocating a section could drop
 * one and every gate stayed green. That is how the `TEAM_PROTOCOL.md` pointer
 * went missing on 2026-08-17.
 *
 * The set is global, not per-doc: moving a pointer from CLAUDE.md into a linked
 * file is the index pattern working, not a loss. Losing it everywhere is a loss.
 * A deliberate removal is recorded with `--accept-refs`.
 */
function checkRefRatchet(ctx) {
  const pointerDocs = livePointerDocs();
  const now = new Set(currentRefs(pointerDocs));
  if (!exists(REFS)) {
    return { ok: true, lines: ['ok   no snapshot yet — run `gates.cjs --accept-refs` to arm the ratchet'] };
  }
  const recorded = JSON.parse(read(REFS)).paths || [];
  const dropped = recorded.filter((p) => !now.has(p));
  // A drop blocks when the path itself or any pointer doc is in this commit.
  const stagedDocs = pointerDocs.map(rel);
  const lines = [];
  let blocking = 0;
  for (const p of dropped) {
    const hit = `DROPPED ${p} — was referenced, now referenced nowhere. Restore the pointer, or run \`gates.cjs --accept-refs\` if the removal is deliberate.`;
    if (blocks(ctx, p, ...stagedDocs)) { lines.push(hit); blocking++; } else lines.push(`warn ${hit} (not staged)`);
  }
  for (const p of [...now].filter((p) => !recorded.includes(p))) lines.push(`new     ${p}`);
  if (!dropped.length) lines.push(`ok   ${recorded.length} recorded references still reachable`);
  return { ok: blocking === 0, lines };
}

/** Every SKILL.md has usable frontmatter and a name that matches its directory. */
function checkSkillMetadata() {
  const lines = [];
  let ok = true;
  const skillsDir = path.join(ROOT, 'skills');
  if (!exists(skillsDir)) return { ok: true, lines: ['ok   no skills/ directory'] };
  let count = 0;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const dirPath = path.join(skillsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir) { try { isDir = fs.statSync(dirPath).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    const skillFile = path.join(dirPath, 'SKILL.md');
    if (!exists(skillFile)) continue;
    count++;
    const text = read(skillFile);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fail = (msg) => { lines.push(`skills/${entry.name}: ${msg}`); ok = false; };
    if (!fm) { fail('SKILL.md has no YAML frontmatter block'); continue; }
    const name = fm[1].match(/^name:\s*(.+)$/m);
    const desc = fm[1].match(/^description:\s*([\s\S]+?)(?=\n[a-zA-Z-]+:|$)/m);
    if (!name) fail('frontmatter has no name:');
    else if (name[1].trim() !== entry.name) fail(`frontmatter name "${name[1].trim()}" does not match its directory`);
    if (!desc || !desc[1].trim()) fail('frontmatter has no description: — the model cannot decide when to invoke it');
    else if (desc[1].trim().length > 1024) fail(`description is ${desc[1].trim().length} chars; keep it under 1024`);
  }
  if (ok) lines.push(`ok   ${count} skills have valid invocation metadata`);
  return { ok, lines };
}

/**
 * Every hook script settings.json points at exists. A hook whose target is gone
 * is a guard that silently stopped guarding. Orphan scripts are advisory —
 * some are launched by Task Scheduler or another repo's settings.
 */
function checkHookWiring() {
  const lines = [];
  let ok = true;
  const settingsPath = path.join(ROOT, 'settings.json');
  if (!exists(settingsPath)) return { ok: false, lines: ['settings.json not found'] };
  const settings = JSON.parse(read(settingsPath));
  const settingsCommands = [];
  for (const events of Object.values(settings.hooks || {})) {
    for (const matcher of events) {
      for (const h of matcher.hooks || []) {
        if (h.command) settingsCommands.push(h.command);
        if (Array.isArray(h.args)) settingsCommands.push(h.args.join(' '));
      }
    }
  }
  const commands = [...settingsCommands];
  // git-hooks/ and scripts/ invoke hook scripts too. Without them a
  // legitimately-wired guard reads as an orphan.
  for (const dir of ['git-hooks', 'scripts', 'tools']) {
    for (const f of walk(path.join(ROOT, dir))) {
      if (/\.(sh|ps1|cjs|js|py|bat|cmd)$|^[^.]+$/.test(path.basename(f))) {
        try { commands.push(read(f)); } catch { /* unreadable, skip */ }
      }
    }
  }
  // Since 2026-08-17 the same guard scripts are wired into Codex and Antigravity
  // too (see docs/harness-parity.md). Their configs live outside this repo, so
  // without them a guard that three harnesses depend on reads as an orphan.
  for (const p of [
    path.join(HOME, '.codex', 'hooks.json'),
    path.join(HOME, '.codex', 'config.toml'),
    path.join(HOME, '.gemini', 'config', 'hooks.json'),
  ]) {
    try { if (exists(p)) commands.push(read(p)); } catch { /* unreadable, skip */ }
  }
  // A settings.json command naming an absolute path that does not exist is a
  // guard that silently stopped guarding. That is the failure worth blocking on.
  let targets = 0;
  for (const cmd of settingsCommands) {
    for (const m of cmd.matchAll(/["']?([A-Za-z]:[\\/][^"'\s]+\.(?:cjs|js|py|ps1|vbs|sh))["']?/g)) {
      targets++;
      const p = m[1].replace(/\\/g, '/');
      if (!exists(p)) {
        lines.push(`MISSING hook target: ${p} — a guard that points at nothing does not guard`);
        ok = false;
      }
    }
  }

  // Orphans are advisory: a script may legitimately be launched by Task
  // Scheduler, a .vbs shim, or another repo's settings. Match on basename so a
  // `$HOME`- or `%USERPROFILE%`-relative caller still counts as a reference.
  const haystack = commands.join('\n');
  const orphans = walk(path.join(ROOT, 'hooks'))
    .filter((p) => /\.(cjs|js|py|ps1)$/.test(p) && !rel(p).includes('/tests/'))
    .filter((p) => !haystack.includes(path.basename(p)));
  for (const o of orphans) lines.push(`ORPHAN  ${rel(o)} — nothing in settings.json, git-hooks/, or scripts/ references it`);
  if (ok) lines.push(`ok   ${targets} hook targets exist${orphans.length ? '' : ', no orphans'}`);
  return { ok, lines };
}

const CHECKS = [
  { id: 'doc-budgets', label: 'standing docs stay under their word ceiling', run: checkDocBudgets },
  { id: 'md-links', label: 'every referenced path resolves', run: checkMdLinks },
  { id: 'ref-ratchet', label: 'no pointer lost since the last accepted snapshot', run: checkRefRatchet },
  { id: 'note-format', label: 'decision notes follow the format', run: checkNoteFormat },
  { id: 'rule-expiry', label: 'no expired situational rules', run: checkRuleExpiry },
  { id: 'skill-metadata', label: 'skills have valid invocation metadata', run: checkSkillMetadata },
  { id: 'hook-wiring', label: 'settings.json hook targets exist', run: checkHookWiring },
  { id: 'slop', label: 'doc slop checklist (advisory)', run: checkSlop },
];

// ─────────────────────────────────────────────────────────── report

function writeReport(results, outPath) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const failed = results.filter((r) => !r.ok && !r.advisory).length;
  const body = results.map((r) => {
    const state = r.ok ? 'pass' : r.advisory ? 'warn' : 'fail';
    const rows = r.lines.map((l) => `<li class="${/^(ok|DUP)/.test(l) ? '' : 'hit'}">${esc(l)}</li>`).join('');
    return `<section class="${state}"><h2><span class="dot"></span>${esc(r.id)} <em>${esc(r.label)}</em></h2><ul>${rows}</ul></section>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Harness gates</title>
<style>
:root{--bg:#0f1115;--fg:#e6e6e6;--dim:#8b93a1;--pass:#3fb950;--fail:#f85149;--warn:#d29922;--card:#161b22}
@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1c2024;--dim:#6b7280;--card:#f6f8fa}}
*{box-sizing:border-box}body{margin:0;padding:2rem;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
h1{font-size:1.3rem;margin:0 0 .25rem}.meta{color:var(--dim);margin-bottom:1.5rem}
section{background:var(--card);border-radius:8px;padding:1rem 1.25rem;margin-bottom:1rem;border-left:4px solid var(--dim)}
section.pass{border-left-color:var(--pass)}section.fail{border-left-color:var(--fail)}section.warn{border-left-color:var(--warn)}
h2{font-size:1rem;margin:0 0 .6rem;display:flex;align-items:center;gap:.5rem}
h2 em{font-style:normal;color:var(--dim);font-weight:400;font-size:.85rem}
.dot{width:9px;height:9px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.pass .dot{background:var(--pass)}.fail .dot{background:var(--fail)}.warn .dot{background:var(--warn)}
ul{margin:0;padding-left:1.1rem;list-style:none}li{color:var(--dim);padding:.1rem 0;white-space:pre-wrap;word-break:break-word}
li.hit{color:var(--fg)}
</style>
<h1>Harness gates ${failed ? `— ${failed} failing` : '— all green'}</h1>
<div class="meta">${esc(stamp)} · ${esc(ROOT)} · re-run: <code>node tools/gates/gates.cjs --report</code></div>
${body}`;
  fs.writeFileSync(outPath, html, 'utf8');
}

function open(file) {
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ─────────────────────────────────────────────────────────── main

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const ids = argv.filter((a) => !a.startsWith('--'));

  if (flags.has('--list')) {
    for (const c of CHECKS) console.log(`${c.id.padEnd(16)} ${c.label}`);
    return 0;
  }

  if (flags.has('--accept-refs')) {
    const paths = currentRefs(livePointerDocs());
    fs.writeFileSync(REFS, `${JSON.stringify({
      _comment: 'Every path the standing docs point at. The ref-ratchet gate fails when one of these is referenced nowhere any more, which is what catches a pointer dropped during a relocation. Regenerate with `gates.cjs --accept-refs` when a removal is deliberate; review the diff before committing.',
      paths,
    }, null, 2)}\n`, 'utf8');
    console.log(`accepted ${paths.length} references → ${rel(REFS)}`);
    return 0;
  }

  const selected = ids.length ? CHECKS.filter((c) => ids.includes(c.id)) : CHECKS;
  const unknown = ids.filter((i) => !CHECKS.some((c) => c.id === i));
  if (unknown.length) {
    console.error(`unknown check: ${unknown.join(', ')} (try --list)`);
    return 2;
  }

  // Always SCAN the full standing set, never just what is staged: a rename in
  // one doc breaks a link in another, and a staged-only scan misses exactly
  // that. --staged only changes what BLOCKS: see blocks() above.
  const staged = flags.has('--staged') ? stagedPaths() : null;
  const ctx = { docs: standingDocs(), mdLinkDocs: mdLinkDocs(), today: new Date().toISOString().slice(0, 10), staged };
  if (staged) console.log(`scope: --staged, ${staged.size} path(s) in the index decide what blocks; everything else warns`);

  const results = [];
  let failed = 0;
  for (const check of selected) {
    let r;
    try {
      r = check.run(ctx);
    } catch (err) {
      r = { ok: false, lines: [`check threw: ${err.message}`] };
    }
    const advisory = Boolean(r.advisory) && !flags.has('--strict');
    results.push({ id: check.id, label: check.label, ok: r.ok, advisory: advisory && !r.ok, lines: r.lines });
    const tag = r.ok ? 'PASS' : advisory ? 'WARN' : 'FAIL';
    console.log(`${tag}  ${check.id}  ${check.label}`);
    for (const line of r.lines) console.log(`      ${line}`);
    if (!r.ok && !advisory) failed++;
  }

  if (flags.has('--report')) {
    const out = path.join(__dirname, 'gates-report.html');
    writeReport(results, out);
    console.log(`\nreport: ${out}`);
    open(out);
  }

  console.log(`\n${failed ? `${failed} gate(s) failed` : `${selected.length} gate(s) green`}`);
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
