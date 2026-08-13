#!/usr/bin/env node
'use strict';

/*
 * spend.cjs — Claude Code token/dollar spend ledger.
 *
 * Scans C:\Users\sandm\.claude\projects\<slug>\<session-uuid>.jsonl transcripts
 * for assistant `message.usage` records and renders spend.html + a terminal
 * summary showing tokens and estimated dollars per day, per model, per
 * session. Built after two billing incidents (claude-mem $227,
 * security-guidance $95) and a 110-agent Fable fleet burn happened with zero
 * cost visibility — fleet.cjs shows activity, spend.cjs shows cost.
 *
 * Zero dependencies. See README.md for the dedup and incremental-cache design.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUT_HTML = path.join(__dirname, 'spend.html');
const CACHE_FILE = path.join(__dirname, 'spend-cache.json');
const DEFAULT_DAYS = 7;

// ---------------------------------------------------------------------------
// PRICES — $ per million tokens, base input/output rates. EDIT HERE.
// Sourced from Anthropic's published per-tier rates as of this tool's build
// date (2026-08-13). These are ESTIMATES for cost visibility, not billing —
// actual invoices depend on exact account pricing, batch discounts, and
// service tier. Matched against `message.model` by substring (case-
// insensitive), so "claude-opus-5", "claude-opus-4-8", etc. all hit "opus".
//
// "fable" has no published public price (internal/escalation-tier model) —
// priced here as a placeholder equal to the opus tier. Flagged as such in
// both the terminal output and the HTML page. Adjust when a real rate ships.
const PRICES = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
  fable: { in: 15, out: 75, placeholder: true },
};

// Prompt-caching multipliers off each tier's base input rate (Anthropic's
// standard ratios): a 5-minute cache write costs 1.25x base input, a
// 1-hour write costs 2x, and a cache read costs 0.1x. Applied uniformly
// across tiers since Anthropic does not publish per-model cache multipliers.
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const CACHE_READ_MULT = 0.1;

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettySlug(dirName) {
  return dirName.replace(/^C--/, '');
}

function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

// dollars: number|null (null = unknown model, no price). hasUnknown: true if
// some tokens in this row came from a model with no price match.
function fmtDollars(dollars, hasUnknown) {
  if (dollars === null) return '?';
  if (dollars === 0 && hasUnknown) return '?';
  const base = '$' + dollars.toFixed(2);
  return hasUnknown ? base + '+?' : base;
}

function formatRelative(ms) {
  const diffMs = Date.now() - ms;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return diffSec <= 1 ? 'just now' : `${diffSec} sec ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

// Local calendar day (YYYY-MM-DD) for a record's ISO timestamp. en-CA locale
// formats as ISO order — a zero-dependency way to get Y-M-D without a date lib.
function dayKey(tsIso) {
  if (!tsIso) return 'unknown';
  const d = new Date(tsIso);
  if (isNaN(d.getTime())) return 'unknown';
  return d.toLocaleDateString('en-CA');
}

function tierFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return null;
}

function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, messages: 0 };
}

function addUsage(bucket, usage) {
  bucket.input += usage.input_tokens || 0;
  bucket.output += usage.output_tokens || 0;
  bucket.cacheRead += usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation || {};
  let w5 = cc.ephemeral_5m_input_tokens || 0;
  let w1 = cc.ephemeral_1h_input_tokens || 0;
  // Older/shape-drifted records may carry only the flat total with no
  // 5m/1h breakdown — assume 5m (the more common, cheaper case) rather
  // than silently dropping the tokens.
  if (!w5 && !w1 && usage.cache_creation_input_tokens) {
    w5 = usage.cache_creation_input_tokens;
  }
  bucket.cacheWrite5m += w5;
  bucket.cacheWrite1h += w1;
  bucket.messages += 1;
}

function mergeBucketInto(target, src) {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite5m += src.cacheWrite5m;
  target.cacheWrite1h += src.cacheWrite1h;
  target.messages += src.messages;
}

// dollars for one (model, bucket) pair. null if the model has no price entry.
function costForBucket(model, bucket) {
  const tier = tierFor(model);
  if (!tier) return null;
  const p = PRICES[tier];
  return (
    bucket.input * p.in +
    bucket.output * p.out +
    bucket.cacheWrite5m * p.in * CACHE_WRITE_5M_MULT +
    bucket.cacheWrite1h * p.in * CACHE_WRITE_1H_MULT +
    bucket.cacheRead * p.in * CACHE_READ_MULT
  ) / 1e6;
}

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`spend: warning — cache file unreadable (${e.message}), rebuilding from scratch`);
    }
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

// Incrementally process one transcript file against its cache entry (if any).
// Returns { size, mtimeMs, byteOffset, lastMessageId, perDay, read } where
// `read` is false only when the file was fully served from cache (size and
// mtime unchanged since last run).
async function processFile(filePath, stat, cachedEntry) {
  const size = stat.size;
  const mtimeMs = stat.mtimeMs;
  let offset = 0;
  let perDay = {};
  let lastMessageId = null;

  if (cachedEntry) {
    if (size < cachedEntry.size || mtimeMs < cachedEntry.mtimeMs) {
      // Shrank or went backwards in time — rotated/truncated. Re-read from 0.
      offset = 0;
      perDay = {};
      lastMessageId = null;
    } else if (size === cachedEntry.size && mtimeMs === cachedEntry.mtimeMs) {
      // Unchanged — fully served from cache, no bytes read.
      return {
        size, mtimeMs,
        byteOffset: cachedEntry.byteOffset,
        lastMessageId: cachedEntry.lastMessageId,
        perDay: cachedEntry.perDay,
        read: false,
      };
    } else {
      // Grew — read only the appended bytes.
      offset = cachedEntry.byteOffset;
      perDay = JSON.parse(JSON.stringify(cachedEntry.perDay));
      lastMessageId = cachedEntry.lastMessageId;
    }
  }

  if (offset >= size) {
    return { size, mtimeMs, byteOffset: offset, lastMessageId, perDay, read: false };
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start: offset, end: size - 1, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch (e) {
        return; // skip unparseable/torn lines (e.g. read raced a mid-write)
      }
      if (rec.type !== 'assistant' || !rec.message || !rec.message.usage) return;
      const msg = rec.message;
      if (!msg.id) return;
      // Claude Code writes one JSONL line per content block; every block of
      // the same assistant turn repeats the same message.id and the same
      // cumulative usage. Only count a turn once, on its first line.
      if (msg.id === lastMessageId) return;
      lastMessageId = msg.id;
      const day = dayKey(rec.timestamp);
      const model = msg.model || 'unknown';
      if (!perDay[day]) perDay[day] = {};
      if (!perDay[day][model]) perDay[day][model] = emptyBucket();
      addUsage(perDay[day][model], msg.usage);
    });
    rl.on('close', resolve);
    stream.on('error', reject);
    rl.on('error', reject);
  });

  return { size, mtimeMs, byteOffset: size, lastMessageId, perDay, read: true };
}

async function scan(projectsDir, days) {
  if (!fs.existsSync(projectsDir)) {
    console.error(`spend: projects directory not found: ${projectsDir}`);
    process.exit(1);
  }

  const windowMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cache = loadCache();

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    console.error(`spend: cannot read projects directory: ${e.message}`);
    process.exit(1);
  }

  const candidates = [];
  for (const projectDir of projectDirs) {
    const fullProjectDir = path.join(projectsDir, projectDir);
    let entries;
    try {
      entries = fs.readdirSync(fullProjectDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(fullProjectDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (e) {
        continue;
      }
      if (now - stat.mtimeMs > windowMs) continue; // outside window — never opened
      candidates.push({
        filePath,
        slug: prettySlug(projectDir),
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        stat,
      });
    }
  }

  const sessions = [];
  let cachedCount = 0;
  let readCount = 0;

  for (const c of candidates) {
    const cachedEntry = cache[c.filePath];
    const result = await processFile(c.filePath, c.stat, cachedEntry);
    if (result.read) readCount++; else cachedCount++;

    cache[c.filePath] = {
      size: result.size,
      mtimeMs: result.mtimeMs,
      byteOffset: result.byteOffset,
      lastMessageId: result.lastMessageId,
      perDay: result.perDay,
    };

    sessions.push({
      filePath: c.filePath,
      slug: c.slug,
      sessionId: c.sessionId,
      shortId: c.sessionId.slice(0, 8),
      mtimeMs: result.mtimeMs,
      perDay: result.perDay,
    });
  }

  saveCache(cache);

  return { sessions, cachedCount, readCount };
}

// Roll per-session perDay data up into perDay-global, perModel-global, and a
// per-session summary bucket (model mix + totals) for rendering.
function aggregate(sessions) {
  const dayTotals = {}; // day -> { models: {model: bucket}, }
  const modelTotals = {}; // model -> bucket

  const sessionSummaries = sessions.map((s) => {
    const modelBuckets = {}; // model -> bucket, summed across this session's days
    for (const day of Object.keys(s.perDay)) {
      if (!dayTotals[day]) dayTotals[day] = {};
      for (const model of Object.keys(s.perDay[day])) {
        const bucket = s.perDay[day][model];

        if (!dayTotals[day][model]) dayTotals[day][model] = emptyBucket();
        mergeBucketInto(dayTotals[day][model], bucket);

        if (!modelTotals[model]) modelTotals[model] = emptyBucket();
        mergeBucketInto(modelTotals[model], bucket);

        if (!modelBuckets[model]) modelBuckets[model] = emptyBucket();
        mergeBucketInto(modelBuckets[model], bucket);
      }
    }

    let totalTokens = 0;
    let totalDollars = 0;
    let hasUnknown = false;
    for (const model of Object.keys(modelBuckets)) {
      const b = modelBuckets[model];
      totalTokens += b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
      const d = costForBucket(model, b);
      if (d === null) hasUnknown = true; else totalDollars += d;
    }

    return {
      ...s,
      modelBuckets,
      models: Object.keys(modelBuckets),
      totalTokens,
      totalDollars,
      hasUnknown,
    };
  });

  sessionSummaries.sort((a, b) => b.totalDollars - a.totalDollars || b.totalTokens - a.totalTokens);

  return { dayTotals, modelTotals, sessionSummaries };
}

function rowTotals(bucket) {
  return bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite5m + bucket.cacheWrite1h;
}

function printSummary(dayTotals, cachedCount, readCount, days) {
  const days_ = Object.keys(dayTotals).sort(); // ascending in terminal, oldest first
  let grandIn = 0, grandOut = 0, grandCache = 0, grandDollars = 0, grandUnknown = false;

  for (const day of days_) {
    let dayIn = 0, dayOut = 0, dayCache = 0, dayDollars = 0, dayUnknown = false;
    for (const model of Object.keys(dayTotals[day])) {
      const b = dayTotals[day][model];
      dayIn += b.input;
      dayOut += b.output;
      dayCache += b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
      const d = costForBucket(model, b);
      if (d === null) dayUnknown = true; else dayDollars += d;
    }
    grandIn += dayIn; grandOut += dayOut; grandCache += dayCache;
    grandDollars += dayDollars; grandUnknown = grandUnknown || dayUnknown;
    console.log(
      `${day}  in ${fmtNum(dayIn)}  out ${fmtNum(dayOut)}  cache ${fmtNum(dayCache)}  ~${fmtDollars(dayDollars, dayUnknown)}`
    );
  }

  console.log(
    `TOTAL (${days}d)  in ${fmtNum(grandIn)}  out ${fmtNum(grandOut)}  cache ${fmtNum(grandCache)}  ~${fmtDollars(grandDollars, grandUnknown)}`
  );
  console.log(`${cachedCount} cached / ${readCount} read`);
}

function renderHtml(dayTotals, modelTotals, sessionSummaries, days, cachedCount, readCount) {
  const generatedAt = new Date().toLocaleString();

  let grandDollars = 0;
  let grandUnknown = false;
  let grandTokens = 0;
  for (const model of Object.keys(modelTotals)) {
    const b = modelTotals[model];
    grandTokens += rowTotals(b);
    const d = costForBucket(model, b);
    if (d === null) grandUnknown = true; else grandDollars += d;
  }

  const dayRows = Object.keys(dayTotals).sort().reverse().map((day) => {
    let dayIn = 0, dayOut = 0, dayCacheRead = 0, dayCacheWrite = 0, dayDollars = 0, dayUnknown = false;
    for (const model of Object.keys(dayTotals[day])) {
      const b = dayTotals[day][model];
      dayIn += b.input;
      dayOut += b.output;
      dayCacheRead += b.cacheRead;
      dayCacheWrite += b.cacheWrite5m + b.cacheWrite1h;
      const d = costForBucket(model, b);
      if (d === null) dayUnknown = true; else dayDollars += d;
    }
    return `<tr><td>${htmlEscape(day)}</td><td class="num">${fmtNum(dayIn)}</td><td class="num">${fmtNum(dayOut)}</td><td class="num">${fmtNum(dayCacheRead)}</td><td class="num">${fmtNum(dayCacheWrite)}</td><td class="num money">~${fmtDollars(dayDollars, dayUnknown)}</td></tr>`;
  }).join('\n');

  const modelRows = Object.keys(modelTotals)
    .map((model) => ({ model, b: modelTotals[model], d: costForBucket(model, modelTotals[model]) }))
    .sort((a, b) => (b.d || 0) - (a.d || 0))
    .map(({ model, b, d }) => {
      const tier = tierFor(model);
      const placeholderBadge = tier && PRICES[tier].placeholder ? ' <span class="badge-est">placeholder price</span>' : '';
      const unknownBadge = !tier ? ' <span class="badge-est">no price entry</span>' : '';
      return `<tr><td>${htmlEscape(model)}${placeholderBadge}${unknownBadge}</td><td class="num">${fmtNum(b.input)}</td><td class="num">${fmtNum(b.output)}</td><td class="num">${fmtNum(b.cacheRead)}</td><td class="num">${fmtNum(b.cacheWrite5m + b.cacheWrite1h)}</td><td class="num">${fmtNum(b.messages)}</td><td class="num money">~${fmtDollars(d, !tier)}</td></tr>`;
    }).join('\n');

  const sessionRows = sessionSummaries.map((s) => {
    const modelMix = s.models.map((m) => htmlEscape(m)).join(', ') || '(none)';
    const perModelRows = Object.keys(s.modelBuckets).map((model) => {
      const b = s.modelBuckets[model];
      const d = costForBucket(model, b);
      return `<tr><td>${htmlEscape(model)}</td><td class="num">${fmtNum(b.input)}</td><td class="num">${fmtNum(b.output)}</td><td class="num">${fmtNum(b.cacheRead)}</td><td class="num">${fmtNum(b.cacheWrite5m + b.cacheWrite1h)}</td><td class="num money">~${fmtDollars(d, !tierFor(model))}</td></tr>`;
    }).join('\n');
    return `
      <details class="session">
        <summary>
          <span class="s-slug">${htmlEscape(s.slug)}</span>
          <span class="s-id">${htmlEscape(s.shortId)}</span>
          <span class="s-mix">${modelMix}</span>
          <span class="s-time">${htmlEscape(formatRelative(s.mtimeMs))}</span>
          <span class="s-tokens">${fmtNum(s.totalTokens)} tok</span>
          <span class="s-dollars money">~${fmtDollars(s.totalDollars, s.hasUnknown)}</span>
        </summary>
        <table class="inner">
          <thead><tr><th>model</th><th>in</th><th>out</th><th>cache read</th><th>cache write</th><th>est $</th></tr></thead>
          <tbody>${perModelRows}</tbody>
        </table>
      </details>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spend</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink-primary: #ffffff;
    --ink-secondary: #c3c2b7;
    --ink-muted: #898781;
    --border: rgba(255,255,255,0.10);
    --good: #0ca30c;
    --warn: #c78a1f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--ink-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  header { margin-bottom: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px 0; }
  h2 { font-size: 15px; font-weight: 600; margin: 28px 0 10px 0; color: var(--ink-secondary); }
  .subhead { color: var(--ink-secondary); font-size: 14px; }
  .disclaimer {
    margin-top: 8px;
    padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--warn);
    font-size: 12px;
    max-width: 720px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left;
    color: var(--ink-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  tbody td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--ink-secondary);
  }
  tbody tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .money { color: var(--ink-primary); font-weight: 600; }
  .badge-est {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--warn);
    border: 1px solid var(--border);
    vertical-align: middle;
  }
  .sessions { display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  details.session {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  details.session:last-child { border-bottom: none; }
  details.session summary {
    display: grid;
    grid-template-columns: 200px 90px 1fr 90px 90px 100px;
    gap: 12px;
    align-items: center;
    padding: 10px 14px;
    cursor: pointer;
    font-size: 13px;
    list-style: none;
  }
  details.session summary::-webkit-details-marker { display: none; }
  .s-slug { font-weight: 600; }
  .s-id, .s-time { color: var(--ink-muted); font-size: 12px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .s-mix { color: var(--ink-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-tokens { color: var(--ink-secondary); text-align: right; font-variant-numeric: tabular-nums; }
  .s-dollars { text-align: right; }
  table.inner { margin: 0 14px 12px 14px; width: calc(100% - 28px); }
  footer { margin-top: 24px; color: var(--ink-muted); font-size: 12px; }
  @media (max-width: 900px) {
    details.session summary {
      grid-template-columns: 1fr;
      grid-template-areas: "slug" "id" "mix" "time" "tokens" "dollars";
    }
  }
</style>
</head>
<body>
<header>
  <h1>~${fmtDollars(grandDollars, grandUnknown)} estimated spend — last ${days}d</h1>
  <div class="subhead">${fmtNum(grandTokens)} tokens across ${sessionSummaries.length} session${sessionSummaries.length === 1 ? '' : 's'} · ${cachedCount} cached / ${readCount} read this run · generated ${htmlEscape(generatedAt)}</div>
  <div class="disclaimer">Estimated costs only, not official Anthropic billing. Prices are per-tier public rates matched by substring on the model id (see PRICES table in spend.cjs). Cache-write cost splits 5-minute vs 1-hour writes using Anthropic's standard 1.25x/2x input-price multipliers. "fable" has no published price — it is priced as a placeholder equal to the opus tier until a real rate is known.</div>
</header>

<h2>Per day</h2>
<table>
  <thead><tr><th>day</th><th>in</th><th>out</th><th>cache read</th><th>cache write</th><th>est $</th></tr></thead>
  <tbody>${dayRows || '<tr><td colspan="6">No usage in window.</td></tr>'}</tbody>
</table>

<h2>Per model</h2>
<table>
  <thead><tr><th>model</th><th>in</th><th>out</th><th>cache read</th><th>cache write</th><th>msgs</th><th>est $</th></tr></thead>
  <tbody>${modelRows || '<tr><td colspan="7">No usage in window.</td></tr>'}</tbody>
</table>

<h2>Per session</h2>
<div class="sessions">
${sessionRows || '<div style="padding:14px;color:var(--ink-muted);">No sessions in window.</div>'}
</div>

<footer>
  Static snapshot — re-run <code>node spend.cjs</code> to refresh. Incremental cache in <code>spend-cache.json</code> makes reruns cheap.
</footer>
</body>
</html>
`;
}

function openFile(filePath) {
  spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const args = process.argv.slice(2);
  const doOpen = args.includes('--open');

  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`spend: invalid --days value`);
    process.exit(1);
  }

  // Testing/debugging hook only — lets the break-it check point the scanner
  // at a nonexistent directory without touching the default path.
  const dirIdx = args.indexOf('--projects-dir');
  const projectsDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : DEFAULT_PROJECTS_DIR;

  const { sessions, cachedCount, readCount } = await scan(projectsDir, days);
  const { dayTotals, modelTotals, sessionSummaries } = aggregate(sessions);

  printSummary(dayTotals, cachedCount, readCount, days);

  const html = renderHtml(dayTotals, modelTotals, sessionSummaries, days, cachedCount, readCount);
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(OUT_HTML);

  if (doOpen) openFile(OUT_HTML);
}

main().catch((e) => {
  console.error(`spend: fatal — ${e.stack || e.message}`);
  process.exit(1);
});
