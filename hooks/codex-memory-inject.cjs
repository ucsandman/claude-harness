#!/usr/bin/env node
'use strict';
/*
 * codex-memory-inject.cjs — SessionStart hook for Codex CLI.
 *
 * Claude Code carries three memory layers into every session that Codex did not
 * see at all (2026-09-05 audit, the cause of "Codex feels like a stranger"):
 *
 *   1. ~/.agents/memory/PROJECTS.md         the canonical project map
 *   2. ~/.agents/memory/{entities,notes}/*  named facts (devbox, worktree rule, ...)
 *   3. ~/.claude/projects/<slug>/memory/    Claude Code's per-project auto-memory
 *                                            (MEMORY.md index + one file per fact)
 *
 * Identity (SOUL.md) and the user profile already reach Codex through the
 * generated ~/.codex/AGENTS.md; this hook adds the memory that lives outside it.
 * Same files, not a copy: a fact Claude saves at 10:00 is in Codex's next
 * session at 10:01, and Codex is told to save into the same directory with the
 * same frontmatter, so the store stays shared in both directions.
 *
 * Output: Codex SessionStart JSON (hookSpecificOutput.additionalContext).
 * Registered with additionalContextLimit so a big MEMORY.md is not spilled to
 * disk behind a preview. Fail-open: any error prints nothing and exits 0.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const MAX_MEMORY_CHARS = 14000; // MEMORY.md index; the largest today is 18.8K (DashClaw)
const MAX_PROJECTS_CHARS = 6000;

function read(p, cap) {
  try {
    const real = fs.realpathSync(p);
    const roots = [path.join(HOME, '.agents', 'memory'), path.join(HOME, '.claude', 'projects')];
    if (!p.endsWith('.md') || !fs.lstatSync(p).isFile() ||
        !roots.some(root => real.toLowerCase().startsWith(fs.realpathSync(root).toLowerCase() + path.sep))) return null;
    let t = fs.readFileSync(p, 'utf8');
    if (cap && t.length > cap) t = t.slice(0, cap) + `\n[... truncated at ${cap} chars; read ${p} for the rest]`;
    return t;
  } catch {
    return null;
  }
}

function listMd(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Claude Code's project slug: every non-alphanumeric character of the absolute
// cwd becomes '-' (C:\Users\sandm\.codex -> C--Users-sandm--codex).
function projectSlug(cwd) {
  return String(cwd || '').replace(/^\\\\\?\\/, '').replace(/[^A-Za-z0-9]/g, '-');
}

function main() {
  let evt = {};
  try {
    evt = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no stdin: still emit the shared-memory pointers */
  }
  const cwd = evt.cwd || process.cwd();

  const parts = [];
  parts.push(
    '# Shared memory (same files Claude Code reads and writes; not a copy)',
    'Identity and the user profile are already in AGENTS.md. Below is the memory that lives outside it.'
  );

  const projects = read(path.join(HOME, '.agents', 'memory', 'PROJECTS.md'), MAX_PROJECTS_CHARS);
  if (projects) parts.push('', '## Project map (~/.agents/memory/PROJECTS.md)', projects.trim());

  const named = [
    ...listMd(path.join(HOME, '.agents', 'memory', 'entities')),
    ...listMd(path.join(HOME, '.agents', 'memory', 'notes')),
  ];
  if (named.length) {
    parts.push('', '## Named facts (read the file when the topic comes up)');
    for (const f of named) {
      const first = (read(f) || '').split('\n').find((l) => l.trim() && !l.startsWith('---')) || '';
      parts.push(`- ${f.replace(HOME, '~')} — ${first.replace(/^#+\s*/, '').slice(0, 120)}`);
    }
  }

  const slug = projectSlug(cwd);
  const memDir = path.join(HOME, '.claude', 'projects', slug, 'memory');
  const memIndex = path.join(memDir, 'MEMORY.md');
  const index = read(memIndex, MAX_MEMORY_CHARS);
  parts.push('', `## Project memory for this directory (${memDir.replace(HOME, '~')})`);
  if (index && index.trim()) {
    parts.push(
      'MEMORY.md is the index; each line points at one file holding one fact. Read a file when its hook matches the task.',
      '',
      index.trim()
    );
  } else {
    parts.push('No project memory saved for this directory yet.');
  }
  parts.push(
    '',
    'To remember something durable (a user preference, a correction, a project constraint, a reference):',
    `write one file per fact into ${memDir.replace(HOME, '~')} with frontmatter (name, description, metadata.type: user|feedback|project|reference),`,
    'then add one line "- [Title](file.md) — hook" to MEMORY.md there. Claude Code reads the same directory, so the fact reaches both agents.',
    'Never store secrets in memory.'
  );

  const text = parts.join('\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })
  );
}

try {
  main();
} catch {
  process.exit(0);
}
