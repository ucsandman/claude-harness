#!/usr/bin/env node
/**
 * harness-sync — keep the Codex and Antigravity (agy) working agreements in step
 * with the Claude one, from a single source of truth.
 *
 *   node ~/.claude/tools/harness-sync/sync.cjs           # write the files
 *   node ~/.claude/tools/harness-sync/sync.cjs --check    # exit 1 if stale, write nothing
 *
 * Why this exists: ~/.codex/AGENTS.md and ~/.gemini/GEMINI.md were both hand-written
 * in June 2026 and never touched again, while ~/.claude/CLAUDE.md kept growing (the
 * nightly meditation ladder promotes rules into it). By 2026-08-17 the two other
 * harnesses were running on a three-month-old copy of the agreement. Hand-maintaining
 * three copies is what produced that, so the copies are generated instead.
 *
 * What is hand-maintained here: the per-target PREAMBLE only. The body is CLAUDE.md
 * verbatim minus the sections that are actively wrong for a non-Claude harness, so a
 * new rule in CLAUDE.md reaches all three harnesses without touching this file.
 *
 * Human surface: node ~/.claude/tools/harness-sync/parity.cjs --open
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SOURCE = path.join(HOME, '.claude', 'CLAUDE.md');
const SOUL = path.join(HOME, '.claude', 'SOUL.md');
const CHECK_ONLY = process.argv.includes('--check');

// Sections of CLAUDE.md that describe Claude-Code-only machinery. Dropping them
// beats shipping instructions that name tools the target harness does not have.
const DROP_SECTIONS = ['Delegation and Model Routing'];

const TARGETS = [
  {
    id: 'codex',
    label: 'Codex CLI',
    out: path.join(HOME, '.codex', 'AGENTS.md'),
    skillsDir: path.join(HOME, '.codex', 'skills'),
    preamble: `# AGENTS.md — Wes's global working agreement (Codex CLI)

GENERATED FILE. Do not hand-edit: \`node ~/.claude/tools/harness-sync/sync.cjs\`
overwrites it. Edit the source instead: \`~/.claude/CLAUDE.md\`.

Everything below applies to Codex work. A repo's own AGENTS.md and my explicit
instructions override this file.

## How this harness differs from the Claude one

The safety layer is genuinely shared, not reimplemented: \`~/.codex/hooks.json\`
points at the same guard scripts in \`~/.claude/hooks\` that Claude Code uses, so a
fix lands in both at once. The global git pre-commit hook (\`core.hooksPath\`) is
machine-wide, so the secret scan and manifest gate already cover Codex commits.

Tool-name mapping when a rule below names a Claude tool:

| Rule says | In Codex |
|---|---|
| Bash / PowerShell | \`shell\` (\`shell_command\` in transcripts) |
| Edit / Write / MultiEdit | \`apply_patch\` |
| Agent / Task | subagents (\`[agents]\` in config.toml) |
| Artifact | no equivalent; write a file and say where it is |

Model routing: the Opus/Fable/Sonnet/Haiku ladder in the Claude agreement does not
apply here. Codex runs \`gpt-5.5\` at \`xhigh\` per \`~/.codex/config.toml\`. Verify a
model id resolves before writing it anywhere; a wrong id crashes the run.

Guards active in this harness: secret-guard, process-kill-guard, dev-server-guard,
scope-lock, bg-test-guard, repeat-tool-guard, no-auto-compact, correction-tracker,
plus rtk output compression on shell calls. Contract for each, including the
override markers: \`~/.claude/docs/harness-guards.md\`.

Not ported on purpose: agent-model-guard (caps Claude's Fable spawns),
opus-handoff-inject, guard-canary and session-count (they read Claude's own state).
Full parity table: \`~/.claude/docs/harness-parity.md\`.
`,
  },
  {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    out: path.join(HOME, '.gemini', 'GEMINI.md'),
    // ~/.gemini/config/ is agy's global customization root (its own
    // agy-customizations builtin skill documents this).
    skillsDir: path.join(HOME, '.gemini', 'config', 'skills'),
    preamble: `# GEMINI.md — Wes's global working agreement (Antigravity CLI)

GENERATED FILE. Do not hand-edit: \`node ~/.claude/tools/harness-sync/sync.cjs\`
overwrites it. Edit the source instead: \`~/.claude/CLAUDE.md\`.

Everything below applies to agy work. A repo's own AGENTS.md or GEMINI.md and my
explicit instructions override this file.

## How this harness differs from the Claude one

The safety layer is shared. \`~/.gemini/config/hooks.json\` runs the same guard
scripts from \`~/.claude/hooks\` through a translation shim
(\`~/.claude/hooks/adapters/agy-adapter.cjs\`), because agy speaks a different hook
dialect. The global git pre-commit hook is machine-wide, so the secret scan and
manifest gate already cover agy commits.

Tool-name mapping when a rule below names a Claude tool:

| Rule says | In agy |
|---|---|
| Bash / PowerShell | \`run_command\` |
| Write | \`write_to_file\` |
| Edit / MultiEdit | \`replace_file_content\` |
| Read | \`view_file\` |
| Grep / Glob | \`grep_search\` / \`list_dir\` |
| Agent / Task | \`define_subagent\` + \`invoke_subagent\` |
| Artifact | no equivalent; write a file and say where it is |

agy also has two capabilities the Claude harness lacks a direct match for:
\`schedule\` for its own recurring tasks, and \`generate_image\`.

Model routing: the Opus/Fable/Sonnet/Haiku ladder does not apply. Run \`agy models\`
to see what actually resolves before naming one; do not write a model id you have
not confirmed.

Guards active in this harness: secret-guard, process-kill-guard, dev-server-guard,
scope-lock, repeat-tool-guard, correction-tracker, plus rtk output compression on
run_command. Contract and override markers: \`~/.claude/docs/harness-guards.md\`.

Not ported: bg-test-guard and no-auto-compact (agy has no matching event),
agent-model-guard, opus-handoff-inject, guard-canary, session-count.
Full parity table: \`~/.claude/docs/harness-parity.md\`.
`,
  },
];

// Skills shared with the other harnesses. Deliberately curated, not "all 52":
// Codex already warns that it shortened skill descriptions to fit its context
// budget, so every skill added there costs the others clarity. Excluded on
// purpose: the 9 threejs-* skills (niche), the *-workspace variants, meditate and
// harness-health (they operate on Claude's own state), phone/phone-gotchas (the
// sidetap MCP is not wired into these harnesses), and adversarial-review /
// interview / marketing (they call Claude-only Artifact and Workflow tools).
const SHARED_SKILLS = [
  'agent-browser',
  'blindspot',
  'de-vibe',
  'deskclaw',
  'dispatch-blocks',
  'frontend-verify',
  'install-anti-slop',
  'inversion',
  'lateral',
  'polish',
  'preflight',
  'project-graveyard',
  'secrets',
  'ship',
  'six-hats',
  'skillfind',
  'top-one-percent',
  'wes-voice',
  'wrap',
];

const SKILL_SRC = path.join(HOME, '.claude', 'skills');

/**
 * Link the shared skills into a harness's skills directory.
 * Junctions, not copies: a skill edited in ~/.claude/skills is instantly live in
 * all three harnesses, and there is no second copy to drift. Junctions work on
 * Windows without admin rights, unlike symlinks.
 */
function linkSkills(dir, report) {
  fs.mkdirSync(dir, { recursive: true });
  let linked = 0;
  let already = 0;
  const missing = [];
  for (const name of SHARED_SKILLS) {
    const src = path.join(SKILL_SRC, name);
    if (!fs.existsSync(src)) {
      missing.push(name);
      continue;
    }
    const dest = path.join(dir, name);
    let current = null;
    try {
      current = fs.readlinkSync(dest);
    } catch {
      current = null;
    }
    if (current && path.resolve(current) === path.resolve(src)) {
      already++;
      continue;
    }
    if (CHECK_ONLY) {
      report.push(`  would link ${name}`);
      continue;
    }
    // Only ever remove a link we own; never delete a real directory.
    if (current) fs.rmSync(dest, { recursive: true, force: true });
    else if (fs.existsSync(dest)) {
      report.push(`  skipped ${name} (a real directory already exists there)`);
      continue;
    }
    try {
      fs.symlinkSync(src, dest, 'junction');
      linked++;
    } catch (e) {
      report.push(`  FAILED ${name}: ${e.message}`);
    }
  }
  report.push(`  skills: ${already} already linked, ${linked} newly linked` + (missing.length ? `, missing in source: ${missing.join(', ')}` : ''));
  return linked;
}

/** Strip a `## Heading` section (up to the next `## ` or EOF) from a markdown body. */
function dropSection(md, heading) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return md;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

function build(target, source, soul) {
  let body = source;

  // CLAUDE.md pulls the agreement in through Claude Code's `@<absolute path>`
  // import lines (agnostic-rules.md, compiled by agnostic-ai). Codex and agy do
  // not resolve those, so inline each absolute import here. Relative ones
  // (@RTK.md) are Claude-only and are stripped below. This file is the ONLY
  // writer of the Codex and agy agreements; agnostic-ai dropped its own targets
  // for them on 2026-09-03 after a forced sync there erased these preambles.
  body = body.replace(/^@((?:~|[A-Za-z]:)[^\s]+)\s*$/gm, (_line, p) => {
    const file = p.replace(/^~/, HOME);
    try {
      // Drop the imported file's own title and GENERATED-FILE line; this file
      // carries its own header for the target harness.
      return fs.readFileSync(file, 'utf8').replace(/^# [^\n]*\n+(GENERATED FILE[^\n]*\n+)?/, '');
    } catch {
      return `<!-- import not found: ${p} -->`;
    }
  });

  // The source opens with a SOUL.md redirect and a personal-style block that only
  // makes sense inside Claude Code; the generated files carry their own header.
  body = body.replace(/^[\s\S]*?(?=^# CLAUDE\.md)/m, '');
  body = body.replace(/^# CLAUDE\.md[^\n]*\n/m, '');

  for (const s of DROP_SECTIONS) body = dropSection(body, s);

  // Rewrite the self-references that would send the target harness to the wrong file.
  body = body
    .replace(/A project's own `CLAUDE\.md`/g, "A project's own agent instructions file")
    .replace(/@RTK\.md\s*$/m, '');

  const stamp = `<!-- generated by ~/.claude/tools/harness-sync/sync.cjs from ~/.claude/CLAUDE.md + SOUL.md -->`;

  return [
    target.preamble.trimEnd(),
    '',
    '---',
    '',
    '# The agreement',
    '',
    body.trim(),
    '',
    '---',
    '',
    '# Identity (from SOUL.md)',
    '',
    soul.trim(),
    '',
    stamp,
    '',
  ].join('\n');
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`harness-sync: source not found: ${SOURCE}`);
    process.exit(1);
  }
  const source = fs.readFileSync(SOURCE, 'utf8');
  const soul = fs.existsSync(SOUL) ? fs.readFileSync(SOUL, 'utf8') : '(SOUL.md not present)';

  let stale = 0;
  for (const t of TARGETS) {
    const next = build(t, source, soul);
    const prev = fs.existsSync(t.out) ? fs.readFileSync(t.out, 'utf8') : null;
    if (prev === next) {
      console.log(`ok      ${t.label.padEnd(22)} ${t.out}`);
    } else {
      stale++;
      if (CHECK_ONLY) {
        console.log(`STALE   ${t.label.padEnd(22)} ${t.out}`);
      } else {
        fs.mkdirSync(path.dirname(t.out), { recursive: true });
        fs.writeFileSync(t.out, next);
        const kb = (Buffer.byteLength(next) / 1024).toFixed(1);
        console.log(`written ${t.label.padEnd(22)} ${t.out}  (${kb} KB)`);
      }
    }

    const report = [];
    linkSkills(t.skillsDir, report);
    for (const line of report) console.log(line);
  }

  if (CHECK_ONLY && stale) {
    console.error(`\nharness-sync: ${stale} file(s) stale. Run without --check to regenerate.`);
    process.exit(1);
  }
  if (!stale) console.log('\nall harness agreements in sync');
}

main();
