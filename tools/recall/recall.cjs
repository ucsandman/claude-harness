#!/usr/bin/env node
'use strict';

/*
 * recall.cjs — one search across every institutional-memory store on this
 * machine, so "have we hit this before?" is one command instead of 3-4
 * separate greps.
 *
 * Sources:
 *   1. memory  — C:\Users\sandm\.claude\projects\<slug>\memory\*.md
 *   2. docs    — C:\Projects\<repo>\docs\DECISIONS.md / ERRORS.md
 *   3. archive — C:\Projects\archives\claude-mem-2026-08-11\data\*.jsonl
 *
 * Zero dependencies. See README.md for the streaming-read design constraint
 * on the archive (files run 4-47 MB) and the record shapes observed there.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const MEMORY_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROJECTS_ROOT = 'C:\\Projects';
const ARCHIVE_DIR = path.join(PROJECTS_ROOT, 'archives', 'claude-mem-2026-08-11', 'data');
const ARCHIVE_FILES = ['observations.jsonl', 'session-summaries.jsonl', 'user-prompts.jsonl'];

const OUT_HTML = path.join(__dirname, 'recall.html');
const SNIPPET_LEN = 200;
const RESULT_CAP = 30;

// ---------------------------------------------------------------- helpers

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s, len) {
  if (s.length <= len) return s;
  return s.slice(0, len) + '…';
}

// Never open these regardless of source globs — belt and suspenders even
// though none of the three sources' patterns should ever hit an env file.
function isEnvFile(name) {
  return name === '.env' || /\.env$/i.test(name);
}

function findSnippet(text, terms, reRegex) {
  let idx = -1;
  let len = 0;
  if (reRegex) {
    const m = text.match(reRegex);
    if (m) {
      idx = m.index;
      len = m[0].length;
    }
  } else {
    const lower = text.toLowerCase();
    for (const t of terms) {
      const i = lower.indexOf(t.toLowerCase());
      if (i !== -1 && (idx === -1 || i < idx)) {
        idx = i;
        len = t.length;
      }
    }
  }
  if (idx === -1) {
    idx = 0;
    len = 0;
  }
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + len + 120);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return truncate(snippet, SNIPPET_LEN);
}

function highlightHtml(snippet, terms, reRegex) {
  let escaped = htmlEscape(snippet);
  try {
    if (reRegex) {
      const flags = reRegex.flags.includes('g') ? reRegex.flags : reRegex.flags + 'g';
      const g = new RegExp(reRegex.source, flags);
      escaped = escaped.replace(g, (m) => `<mark>${m}</mark>`);
    } else {
      for (const t of terms) {
        if (!t) continue;
        const re = new RegExp(escapeRegex(htmlEscape(t)), 'gi');
        escaped = escaped.replace(re, (m) => `<mark>${m}</mark>`);
      }
    }
  } catch (e) {
    // best effort — leave unhighlighted if the term can't build a safe regex
  }
  return escaped;
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '');
}

// Minimal frontmatter reader — not a full YAML parser. Pulls name,
// description, type (possibly nested under metadata:), and modified, all as
// single-line values, which is the shape every memory file on this machine
// actually uses.
function parseFrontmatter(text) {
  const fm = {};
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const block = text.slice(3, end);
      const nameM = block.match(/^name:\s*(.+)$/m);
      if (nameM) fm.name = stripQuotes(nameM[1].trim());
      const descM = block.match(/^description:\s*(.+)$/m);
      if (descM) fm.description = stripQuotes(descM[1].trim());
      const typeM = block.match(/^\s*type:\s*(.+)$/m);
      if (typeM) fm.type = stripQuotes(typeM[1].trim());
      const modM = block.match(/^\s*modified:\s*(.+)$/m);
      if (modM) fm.modified = stripQuotes(modM[1].trim());
      const bodyStart = text.indexOf('\n', end + 4);
      return { frontmatter: fm, body: bodyStart !== -1 ? text.slice(bodyStart + 1) : '' };
    }
  }
  return { frontmatter: fm, body: text };
}

// ------------------------------------------------------------ source: memory

function scanMemory(matchFn, terms, reRegex) {
  const results = [];
  if (!fs.existsSync(MEMORY_PROJECTS_DIR)) {
    return { results, skipped: `memory: not found at ${MEMORY_PROJECTS_DIR}` };
  }
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(MEMORY_PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return { results, skipped: `memory: cannot read ${MEMORY_PROJECTS_DIR}: ${e.message}` };
  }

  for (const slug of projectDirs) {
    const memDir = path.join(MEMORY_PROJECTS_DIR, slug, 'memory');
    let entries;
    try {
      entries = fs.readdirSync(memDir, { withFileTypes: true });
    } catch (e) {
      continue; // no memory dir for this project slug
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (isEnvFile(entry.name)) continue;
      const filePath = path.join(memDir, entry.name);
      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(text);
      const searchText = [frontmatter.name, frontmatter.description, frontmatter.type, body]
        .filter(Boolean)
        .join('\n');
      if (!matchFn(searchText)) continue;

      let date = null;
      if (frontmatter.modified) {
        const d = new Date(frontmatter.modified);
        if (!isNaN(d)) date = d;
      }
      if (!date) {
        try {
          date = fs.statSync(filePath).mtime;
        } catch (e) {
          date = null;
        }
      }

      results.push({
        source: 'memory',
        date,
        file: filePath,
        title: frontmatter.name || entry.name.replace(/\.md$/, ''),
        snippet: findSnippet(searchText, terms, reRegex),
      });
    }
  }
  return { results, skipped: null };
}

// -------------------------------------------------------------- source: docs

function splitDecisionEntries(text) {
  const entries = [];
  const re = /^##\s+(.+)$/gm;
  const matches = [];
  let m;
  while ((m = re.exec(text))) matches.push({ index: m.index, heading: m[1].trim() });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(start, end);
    const bodyStart = block.indexOf('\n');
    const body = bodyStart !== -1 ? block.slice(bodyStart + 1) : '';
    const dateM = matches[i].heading.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateM ? new Date(dateM[1]) : null;
    entries.push({ heading: matches[i].heading, body, date: date && !isNaN(date) ? date : null });
  }
  return entries;
}

function scanDocs(matchFn, terms, reRegex) {
  const results = [];
  if (!fs.existsSync(PROJECTS_ROOT)) {
    return { results, skipped: `docs: not found at ${PROJECTS_ROOT}` };
  }
  let repoDirs;
  try {
    repoDirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return { results, skipped: `docs: cannot read ${PROJECTS_ROOT}: ${e.message}` };
  }

  for (const repo of repoDirs) {
    for (const fname of ['DECISIONS.md', 'ERRORS.md']) {
      const filePath = path.join(PROJECTS_ROOT, repo, 'docs', fname);
      if (!fs.existsSync(filePath)) continue;
      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        continue;
      }
      let mtime = null;
      try {
        mtime = fs.statSync(filePath).mtime;
      } catch (e) {
        mtime = null;
      }

      const entries = splitDecisionEntries(text);
      if (entries.length) {
        for (const entry of entries) {
          const searchText = entry.heading + '\n' + entry.body;
          if (!matchFn(searchText)) continue;
          results.push({
            source: 'docs',
            date: entry.date || mtime,
            file: filePath,
            title: `${repo} — ${entry.heading}`,
            snippet: findSnippet(searchText, terms, reRegex),
          });
        }
      } else {
        // No "## " headings — fall back to matching lines with 2 lines of context.
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!matchFn(lines[i])) continue;
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          const context = lines.slice(start, end).join(' ').replace(/\s+/g, ' ').trim();
          results.push({
            source: 'docs',
            date: mtime,
            file: filePath,
            title: `${repo} — ${fname}`,
            snippet: truncate(context, SNIPPET_LEN),
          });
        }
      }
    }
  }
  return { results, skipped: null };
}

// ----------------------------------------------------------- source: archive

function scanJsonlFile(filePath, matchFn, terms, reRegex, results) {
  return new Promise((resolve) => {
    let rl;
    try {
      rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
    } catch (e) {
      resolve();
      return;
    }
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch (e) {
        return; // skip unparseable lines
      }
      const stringVals = Object.values(rec).filter((v) => typeof v === 'string');
      const searchText = stringVals.join('\n');
      if (!matchFn(searchText)) return;

      let date = null;
      if (rec.created_at) {
        const d = new Date(rec.created_at);
        if (!isNaN(d)) date = d;
      }
      const title = rec.title || rec.request || rec.prompt_text || path.basename(filePath);
      results.push({
        source: 'archive',
        date,
        file: filePath,
        title: truncate(String(title), 100),
        snippet: findSnippet(searchText, terms, reRegex),
      });
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

async function scanArchive(matchFn, terms, reRegex) {
  const results = [];
  if (!fs.existsSync(ARCHIVE_DIR)) {
    return { results, skipped: `archive: not found at ${ARCHIVE_DIR}` };
  }
  for (const fname of ARCHIVE_FILES) {
    const filePath = path.join(ARCHIVE_DIR, fname);
    if (isEnvFile(fname)) continue;
    if (!fs.existsSync(filePath)) continue;
    await scanJsonlFile(filePath, matchFn, terms, reRegex, results);
  }
  return { results, skipped: null };
}

// --------------------------------------------------------------------- html

function renderHtml(query, results, terms, reRegex, elapsedMs) {
  const generatedAt = new Date().toLocaleString();
  const bySource = { memory: [], docs: [], archive: [] };
  for (const r of results) {
    if (bySource[r.source]) bySource[r.source].push(r);
  }

  const sectionLabels = { memory: 'Memory', docs: 'Docs (DECISIONS / ERRORS)', archive: 'Archive' };

  const section = (key) => {
    const items = bySource[key];
    if (!items.length) return '';
    const rows = items.map((r) => {
      const dateStr = r.date ? r.date.toISOString().slice(0, 10) : 'undated';
      return `
      <div class="row">
        <div class="cell cell-date">${htmlEscape(dateStr)}</div>
        <div class="cell cell-main">
          <div class="title">${htmlEscape(r.title || '')}</div>
          <div class="file">${htmlEscape(r.file)}</div>
          <div class="snippet">${highlightHtml(r.snippet, terms, reRegex)}</div>
        </div>
      </div>`;
    }).join('\n');
    return `
    <section>
      <h2>${htmlEscape(sectionLabels[key])} <span class="count">${items.length}</span></h2>
      <div class="rows">${rows}</div>
    </section>`;
  };

  const body = section('memory') + section('docs') + section('archive');
  const empty = results.length === 0
    ? '<div class="empty-state">0 results.</div>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>recall</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink-primary: #ffffff;
    --ink-secondary: #c3c2b7;
    --ink-muted: #898781;
    --border: rgba(255,255,255,0.10);
    --mark-bg: #4a3b00;
    --mark-ink: #ffd866;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  header { margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px 0; }
  .query { color: var(--ink-secondary); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .subhead { color: var(--ink-secondary); font-size: 14px; }
  section { margin-bottom: 24px; }
  h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
    margin: 0 0 8px 0;
  }
  .count {
    color: var(--ink-muted);
    font-weight: 400;
    font-size: 12px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 12px;
    background: var(--surface);
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child { border-bottom: none; }
  .cell-date {
    color: var(--ink-secondary);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .title { font-weight: 600; margin-bottom: 2px; }
  .file {
    color: var(--ink-muted);
    font-size: 11px;
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    margin-bottom: 6px;
    word-break: break-all;
  }
  .snippet { color: var(--ink-secondary); line-height: 1.4; }
  mark { background: var(--mark-bg); color: var(--mark-ink); border-radius: 2px; padding: 0 2px; }
  .empty-state { color: var(--ink-muted); font-style: italic; padding: 20px 0; }
  footer { margin-top: 20px; color: var(--ink-muted); font-size: 12px; }
  @media (max-width: 700px) {
    .row { grid-template-columns: 1fr; grid-template-areas: "date" "main"; }
    .cell-date { grid-area: date; }
    .cell-main { grid-area: main; }
  }
</style>
</head>
<body>
<header>
  <h1>recall: <span class="query">${htmlEscape(query)}</span></h1>
  <div class="subhead">${results.length} result${results.length === 1 ? '' : 's'} · ${elapsedMs}ms · generated ${htmlEscape(generatedAt)}</div>
</header>
${body || empty}
<footer>
  Static snapshot of the last query. Re-run <code>node recall.cjs "..."</code> to refresh.
</footer>
</body>
</html>
`;
}

// --------------------------------------------------------------------- cli

function openFile(filePath) {
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

function parseArgs(argv) {
  const opts = { any: false, re: false, source: null, all: false, open: false, queryParts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--any') opts.any = true;
    else if (a === '--re') opts.re = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--source') {
      opts.source = argv[i + 1];
      i++;
    } else opts.queryParts.push(a);
  }
  return opts;
}

async function main() {
  const startedAt = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const query = opts.queryParts.join(' ').trim();

  if (!query) {
    console.error('usage: node recall.cjs "search terms" [--any] [--re] [--source memory|docs|archive] [--all] [--open]');
    process.exit(2);
  }
  if (opts.source && !['memory', 'docs', 'archive'].includes(opts.source)) {
    console.error(`invalid --source "${opts.source}" (expected memory, docs, or archive)`);
    process.exit(2);
  }

  let reRegex = null;
  let terms = [];
  if (opts.re) {
    try {
      reRegex = new RegExp(query, 'i');
    } catch (e) {
      console.error(`invalid --re pattern: ${e.message}`);
      process.exit(2);
    }
  } else {
    terms = query.split(/\s+/).filter(Boolean);
  }

  const matchFn = (text) => {
    if (!text) return false;
    if (reRegex) return reRegex.test(text);
    const lower = text.toLowerCase();
    return opts.any
      ? terms.some((t) => lower.includes(t.toLowerCase()))
      : terms.every((t) => lower.includes(t.toLowerCase()));
  };

  const includeSource = (s) => !opts.source || opts.source === s;
  const notes = [];
  let allResults = [];

  if (includeSource('memory')) {
    const { results, skipped } = scanMemory(matchFn, terms, reRegex);
    allResults = allResults.concat(results);
    if (skipped) notes.push(skipped);
  }
  if (includeSource('docs')) {
    const { results, skipped } = scanDocs(matchFn, terms, reRegex);
    allResults = allResults.concat(results);
    if (skipped) notes.push(skipped);
  }
  if (includeSource('archive')) {
    const { results, skipped } = await scanArchive(matchFn, terms, reRegex);
    allResults = allResults.concat(results);
    if (skipped) notes.push(skipped);
  }

  const priority = { memory: 0, docs: 1, archive: 2 };
  allResults.sort((a, b) => {
    const pa = priority[a.source];
    const pb = priority[b.source];
    if (pa !== pb) return pa - pb;
    const da = a.date ? a.date.getTime() : 0;
    const db = b.date ? b.date.getTime() : 0;
    return db - da;
  });

  for (const n of notes) console.log(`note: ${n}`);

  const total = allResults.length;
  const shown = opts.all ? allResults : allResults.slice(0, RESULT_CAP);

  if (total === 0) {
    console.log('0 results');
  } else {
    for (const r of shown) {
      const dateStr = r.date ? r.date.toISOString().slice(0, 10) : 'undated';
      console.log(`[${r.source}] ${dateStr}  ${r.file}`);
      console.log(`  ${r.snippet}`);
    }
    if (!opts.all && total > shown.length) {
      console.log(`+${total - shown.length} more (use --all to see everything)`);
    }
    console.log(`\n${total} result${total === 1 ? '' : 's'} for "${query}"`);
  }

  const elapsedMs = Date.now() - startedAt;
  const html = renderHtml(query, allResults, terms, reRegex, elapsedMs);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(OUT_HTML);
  console.log(`${elapsedMs}ms`);

  if (opts.open) openFile(OUT_HTML);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
