#!/usr/bin/env node
'use strict';
/*
 * errorlog — Claude Code's daily error log.
 *
 * The habit (Fable 5, 2026-08-16): every day, write down what you got wrong.
 * Not feelings. Predictions that missed, beliefs that turned out off, effort
 * wasted on a bad assumption.
 *
 * The point of this tool: I ALREADY WRITE THAT LOG EVERY DAY AND THROW IT AWAY.
 * CLAUDE.md mandates an "ASSUMPTIONS I'M MAKING" block before non-trivial work
 * and a "DEVIATIONS FROM PLAN" block in every summary. Measured 2026-08-16:
 * 272 real deviation blocks across 195 sessions in 7 days, reading like
 * "I expected the vault to define STRIPE_LIVE_SECRET_KEY. It did not."
 * That is a prediction error log. It evaporates into transcript files nobody
 * reads. This harvests it into an append-only store and renders the one thing
 * a pile of mistakes is actually for: what I get wrong REPEATEDLY.
 *
 * No LLM in the loop. Deterministic parse, so the nightly run is free and
 * cannot die on a usage limit — which is exactly what killed NightlyMeditation
 * on 2026-08-16 (weekly mode -> fable -> "You've reached your Fable 5 limit").
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const CORRECTIONS = path.join(CLAUDE_DIR, 'corrections.jsonl');
const STORE_DIR = path.join(CLAUDE_DIR, 'error-log');
const STORE = path.join(STORE_DIR, 'claude.jsonl');
const OUT_HTML = path.join(__dirname, 'errorlog.html');

// A transcript this large is a runaway log, not a work session. Reading it
// would blow the heap for no signal.
const MAX_FILE_BYTES = 120 * 1024 * 1024;

// ---------------------------------------------------------------- buckets
// ponytail: regex heuristics, not a classifier. They only need to be stable
// enough that the same KIND of mistake lands in the same bucket twice, because
// the whole product is the repeat count. Upgrade to embeddings only if buckets
// visibly smear.
// Patterns were written against 483 real deviation bullets harvested on
// 2026-08-16, not guessed. Order matters: first match wins, most specific first.
const BUCKETS = [
  ['my-own-bug', /\b(i botched|my (own )?(edit|test|check|script|regex|patch)s? (broke|breaking|leaked|was wrong)|syntax error|leaked a (key|value|secret)|fixed my (test|helper|script)|false.positive|i (broke|missed) )\b/i],
  ['env-blocked', /\b(hook blocked|blocked (me|the|two|\d)|permission denied|not admin|denied|sandbox|EPERM|access is denied|scope-lock|guard blocked|is not up|not running|ports? .{0,20}(busy|in use)|crashed mid-run|disconnected)\b/i],
  ['plan-was-wrong', /\b(i (expected|assumed|thought|believed|wanted|planned)|plan(ned)? (said|to|for)|expected .{0,40}\b(it|they) did not|turned out|actually (was|is|were)|it does ?n.t|it did not|was not (there|present|defined)|did not exist|no such|does not exist|contrary to|takes a .{0,30}not a)\b/i],
  ['scope-grew', /\b(not in (the )?(original )?(scope|plan)|nobody proposed|plan grew|in scope now|was ?n.t in the plan|added a .{0,20}(fix|step|task)|grew to \d|beyond (the|what)|changed mid-)\b/i],
  ['verification-gap', /\b(skipped|did not (verify|test|run|check)|could not verify|unverified|assumed .{0,20}passed|green but|stopped and verified .{0,20}instead)\b/i],
  ['tool-surprise', /\b(undocumented|deprecat|silently|version mismatch|different signature|rewrit(es|ing) |the (api|cli|flag|command|tool)\b.{0,40}\b(instead|actually|does not))\b/i],
  ['scope-shift', /\b(instead of|had to|was forced|could ?n.t|unable to|out of scope|larger than)\b/i],
];

// A DEVIATIONS block is not all error. Real blocks carry three other things:
// explicit "the plan held" notes, VERIFICATION bullets that leaked past a
// non-standard heading, and neutral bookkeeping. None of those is a thing I
// got wrong, and keeping them buries the ones that are.
const NOISE = [
  /^no (other )?deviations?\b/i,
  /^none\b/i,
  /^(otherwise )?the plan held\b/i,
  /\bplan held\b.{0,20}$/i,
  /^[-`]{1,2}[a-z-]+:/i,            // "--dry-run: prints the correct plan"
  /\bexit (code )?0\b/i,
  /^\d+ (passed|tests?)\b/i,
  /\b\d+ passed, \d+ failed\b/i,
  /^(implementation )?matches the spec\b/i,
];

function bucketOf(text) {
  for (const [name, re] of BUCKETS) if (re.test(text)) return name;
  return 'unclassified';
}

function isNoise(text) {
  return NOISE.some((re) => re.test(text));
}

// ---------------------------------------------------------------- parsing
// The summary format from CLAUDE.md is:
//   DEVIATIONS FROM PLAN:
//   - one line per deviation
//
//   VERIFICATION:
// So a block ends at the next ALL-CAPS heading, a fence, or end of text.
// Not every summary uses the ALL-CAPS form. Title-case and bold/heading
// variants are common, and missing them let VERIFICATION bullets leak into the
// deviation list (observed in the 2026-08-16 seed run).
const NEXT_HEADING = [
  "[A-Z][A-Z'’ ]{4,}:",
  '(?:Verification|Potential concerns?|Things I did ?n.?t touch|Changes made|Next steps?|Risks?|Concerns?|Files? changed)\\b:?',
].join('|');
const HEADING_AHEAD = new RegExp(`\\n[ \\t]*(?:\\*{0,2}|#{1,4} *)(?:${NEXT_HEADING})|\\n[ \\t]*\`\`\`|$`);

function blockAfter(text, heading) {
  const open = new RegExp(heading + '\\**:?\\**[ \\t]*\\n');
  const start = text.search(open);
  if (start === -1) return null;
  const rest = text.slice(start).replace(new RegExp('^' + open.source), '');
  const end = rest.search(HEADING_AHEAD);
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null;
}

// "- foo\n  bar" is ONE deviation, not two. Continuation lines are indented.
function bullets(block) {
  const out = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^[ \t]*[-*•]\s+/.test(line)) out.push(line.replace(/^[ \t]*[-*•]\s+/, '').trim());
    else if (out.length) out[out.length - 1] += ' ' + line.trim();
    else out.push(line.trim());
  }
  return out
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 12)
    .filter((s) => !isNoise(s));
}

function idOf(s) {
  return crypto.createHash('sha1').update(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function localDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function repoOf(file) {
  return path.basename(path.dirname(file));
}

// ---------------------------------------------------------------- harvest
function transcripts(days) {
  if (!fs.existsSync(PROJECTS)) return [];
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= cutoff && st.size <= MAX_FILE_BYTES) out.push(p);
      }
    }
  };
  walk(PROJECTS);
  return out;
}

function harvest(days) {
  const found = [];
  for (const file of transcripts(days)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Cheap prefilter. CLAUDE.md is echoed into every transcript and contains
    // these headings, so a plain grep -l over the file is a FALSE POSITIVE
    // (measured 2026-08-16: 227 "hits" that were all the instruction text).
    // Only an assistant-authored text block counts, checked below.
    if (!raw.includes('DEVIATIONS FROM PLAN') && !raw.includes('ASSUMPTIONS')) continue;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      const day = localDate(o.timestamp);
      if (!day) continue;

      for (const b of o.message.content) {
        if (b.type !== 'text' || typeof b.text !== 'string') continue;

        const dev = blockAfter(b.text, 'DEVIATIONS FROM PLAN');
        if (dev) {
          for (const text of bullets(dev)) {
            found.push({ id: idOf(text), day, ts: o.timestamp, kind: 'deviation', bucket: bucketOf(text), text, repo: repoOf(file) });
          }
        }
        const asm = blockAfter(b.text, "ASSUMPTIONS I'M MAKING");
        if (asm) {
          for (const text of bullets(asm.replace(/^\d+\.\s*/gm, '- '))) {
            found.push({ id: idOf('asm:' + text), day, ts: o.timestamp, kind: 'assumption', bucket: 'stated-assumption', text, repo: repoOf(file) });
          }
        }
      }
    }
  }

  // Wes correcting me is a confirmed miss, already bucketed by the
  // correction-tracker UserPromptSubmit hook.
  if (fs.existsSync(CORRECTIONS)) {
    const cutoff = Date.now() - days * 86400 * 1000;
    for (const line of fs.readFileSync(CORRECTIONS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o.ts || o.promoted) continue;
      if (new Date(o.ts).getTime() < cutoff) continue;
      const text = (o.snippet || '').trim();
      if (!text) continue;
      found.push({ id: idOf('corr:' + o.ts + text), day: localDate(o.ts), ts: o.ts, kind: 'correction', bucket: 'corrected-by-wes:' + o.bucket, text, repo: o.cwd ? path.basename(String(o.cwd)) : '' });
    }
  }
  return found;
}

function loadStore() {
  if (!fs.existsSync(STORE)) return [];
  return fs.readFileSync(STORE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function append(records) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.appendFileSync(STORE, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------- render
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(all, today) {
  const errs = all.filter((r) => r.kind !== 'assumption');

  // The product. A mistake made once is noise; a bucket that shows up on 3+
  // separate days is the thing to actually fix — and it matches the meditation
  // ladder's 1->2 promotion gate (3+ dated entries on 3+ days).
  const byBucket = new Map();
  for (const r of errs) {
    if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, { bucket: r.bucket, days: new Set(), items: [] });
    const g = byBucket.get(r.bucket);
    g.days.add(r.day);
    g.items.push(r);
  }
  const groups = [...byBucket.values()].sort((a, b) => b.days.size - a.days.size || b.items.length - a.items.length);
  // "unclassified recurred 8 days running" is not a finding, it is the
  // classifier shrugging. Never let it reach the gate list.
  const gateReady = groups.filter((g) => g.days.size >= 3 && g.bucket !== 'unclassified');

  const todays = errs.filter((r) => r.day === today);
  const days = [...new Set(errs.map((r) => r.day))].sort().reverse();
  const max = Math.max(1, ...groups.map((g) => g.items.length));

  const row = (r) => `<li><span class="b b-${esc(r.bucket.split(':')[0])}">${esc(r.bucket)}</span> ${esc(r.text)} ${r.repo ? `<span class="repo">${esc(r.repo)}</span>` : ''}</li>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>error log — claude</title><style>
:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink-primary:#fff;--ink-secondary:#c3c2b7;--ink-muted:#898781;--border:rgba(255,255,255,.10);--bad:#d63b3b;--stale:#d6a13b;--good:#0ca30c}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink-primary);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;line-height:1.5}
h1{font-size:20px;font-weight:600;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);margin:32px 0 12px;font-weight:600}
.subhead{color:var(--ink-secondary);font-size:14px}.wrap{max-width:1000px;margin:0 auto}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;min-width:130px}
.card .n{font-size:26px;font-weight:600}.card .l{font-size:12px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.05em}
ul{list-style:none;padding:0;margin:0}
li{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:14px;color:var(--ink-secondary)}
.b{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;margin-right:8px;font-family:ui-monospace,Consolas,monospace;background:rgba(255,255,255,.08);color:var(--ink-muted);white-space:nowrap}
.b-wrong-assumption{background:rgba(214,59,59,.2);color:var(--bad)}.b-verification-gap{background:rgba(214,161,59,.2);color:var(--stale)}
.b-env-blocked{background:rgba(59,130,214,.2);color:#5b9bd5}.b-corrected-by-wes{background:rgba(214,59,59,.28);color:#ff8a8a}
.repo{font-size:11px;color:var(--ink-muted);font-family:ui-monospace,Consolas,monospace;margin-left:6px}
.bar{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:13px}
.bar .t{width:190px;color:var(--ink-secondary);font-family:ui-monospace,Consolas,monospace;font-size:12px}
.bar .g{flex:1;background:rgba(255,255,255,.05);border-radius:4px;height:18px;overflow:hidden}
.bar .f{height:100%;background:var(--bad);opacity:.65}.bar .c{width:110px;color:var(--ink-muted);font-size:12px;text-align:right}
.gate{border-left:3px solid var(--stale);padding-left:12px;margin-bottom:14px}
.gate b{color:var(--stale)}.empty{color:var(--ink-muted);font-size:14px;font-style:italic}
details{margin-bottom:10px}summary{cursor:pointer;color:var(--ink-secondary);font-size:13px;padding:6px 0}
.note{color:var(--ink-muted);font-size:12px;margin-top:14px;max-width:70ch}
</style></head><body><div class="wrap">
<h1>error log — claude</h1>
<div class="subhead">What I predicted that didn't happen. Harvested from my own DEVIATIONS and ASSUMPTIONS blocks. Generated ${new Date().toLocaleString()}.</div>

<div class="cards">
<div class="card"><div class="n">${todays.length}</div><div class="l">today</div></div>
<div class="card"><div class="n">${errs.length}</div><div class="l">all time</div></div>
<div class="card"><div class="n">${days.length}</div><div class="l">days logged</div></div>
<div class="card"><div class="n" style="color:${gateReady.length ? 'var(--stale)' : 'var(--good)'}">${gateReady.length}</div><div class="l">repeat patterns</div></div>
</div>

<h2>Repeating on 3+ separate days &mdash; promotion-gate ready</h2>
${gateReady.length ? gateReady.map((g) => `<div class="gate"><b>${esc(g.bucket)}</b> &mdash; ${g.items.length} times across ${g.days.size} days (${[...g.days].sort().reverse().slice(0, 5).join(', ')})<br><span class="repo">${esc(g.items[g.items.length - 1].text.slice(0, 160))}</span></div>`).join('') : '<div class="empty">Nothing repeating yet. Needs 3+ separate days in one bucket.</div>'}

<h2>Today &mdash; ${esc(today)}</h2>
${todays.length ? `<ul>${todays.map(row).join('')}</ul>` : '<div class="empty">No deviations logged today. Either a clean day or no summaries were written.</div>'}

<h2>Where I go wrong</h2>
${groups.filter((g) => g.bucket !== 'unclassified').map((g) => `<div class="bar"><div class="t">${esc(g.bucket)}</div><div class="g"><div class="f" style="width:${Math.round((g.items.length / max) * 100)}%"></div></div><div class="c">${g.items.length} / ${g.days.size}d</div></div>`).join('') || '<div class="empty">No data yet.</div>'}
<p class="note">Keyword buckets catch about a third of these. The rest is free prose that regex cannot read, so it stays unclassified (${(byBucket.get('unclassified') || { items: [] }).items.length} of ${errs.length}) rather than being forced into a label. Finding the real repeated pattern is the nightly meditation's job &mdash; it reads the raw text below.</p>

<h2>History</h2>
${days.slice(0, 30).map((d) => { const rs = errs.filter((r) => r.day === d); return `<details${d === today ? ' open' : ''}><summary>${esc(d)} &mdash; ${rs.length} logged</summary><ul>${rs.map(row).join('')}</ul></details>`; }).join('') || '<div class="empty">No history yet.</div>'}
</div></body></html>`;
}

// ---------------------------------------------------------------- selftest
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } };

  const summary = [
    'CHANGES MADE:', '- did a thing', '',
    'DEVIATIONS FROM PLAN:',
    '- I expected the vault to define STRIPE_LIVE_SECRET_KEY. It did not.',
    '- A path-protection hook blocked two commands. I worked around it',
    '  with literal paths.', '',
    'VERIFICATION:', '- ran the tests',
  ].join('\n');

  const dev = blockAfter(summary, 'DEVIATIONS FROM PLAN');
  ok('block found', dev !== null);
  ok('block stops at next heading', dev && !/VERIFICATION/.test(dev));
  const bs = bullets(dev);
  ok('two bullets, continuation joined', bs.length === 2);
  ok('continuation actually joined', bs[1].endsWith('with literal paths.'));
  ok('plan-was-wrong bucket', bucketOf(bs[0]) === 'plan-was-wrong');
  ok('env-blocked bucket', bucketOf(bs[1]) === 'env-blocked');
  ok('none is not an error', bullets('- none, the plan held').length === 0);
  ok('scope growth is not wrongness', bucketOf('Auto-cancel was not in the original scope.') === 'scope-grew');
  ok('verification bullet is noise', bullets('- --dry-run: prints the correct plan, exit 0').length === 0);
  ok('"no other deviations" is noise', bullets('- No other deviations. Implementation matches the spec exactly.').length === 0);

  // Title-case headings are common and used to leak VERIFICATION bullets in.
  const titleCase = 'DEVIATIONS FROM PLAN:\n- I expected a flag that does not exist\n\nVerification:\n- ran the suite\n';
  const tc = blockAfter(titleCase, 'DEVIATIONS FROM PLAN');
  ok('stops at title-case heading', tc && !/ran the suite/.test(tc));
  ok('title-case leaves one bullet', bullets(tc).length === 1);

  const bold = '**DEVIATIONS FROM PLAN:**\n- I expected a flag that does not exist\n\n**Verification:**\n- ran the suite\n';
  const bd = blockAfter(bold, 'DEVIATIONS FROM PLAN');
  ok('bold heading parsed', bd !== null && !/ran the suite/.test(bd));
  ok('stable id', idOf('The  Cat') === idOf('the cat'));
  ok('no heading -> null', blockAfter('nothing here', 'DEVIATIONS FROM PLAN') === null);
  ok('short noise dropped', bullets('- ok').length === 0);

  // L1: make the check fail on purpose, or it has been run, not verified.
  const broken = summary.replace('DEVIATIONS FROM PLAN:', 'DEVIATIONS FROM PLANS:');
  ok('negative control: renamed heading yields nothing', bullets(blockAfter(broken, 'DEVIATIONS FROM PLAN:?\\s') || '').length === 0);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- main
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const di = argv.indexOf('--days');
  const days = di !== -1 ? Number(argv[di + 1]) : (argv.includes('--rebuild') ? 30 : 1);
  const today = localDate(new Date().toISOString());

  const existing = loadStore();
  const seen = new Set(existing.map((r) => r.id));
  const fresh = [];
  for (const r of harvest(days)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    fresh.push(r);
  }
  if (fresh.length) append(fresh);

  const all = existing.concat(fresh);
  fs.writeFileSync(OUT_HTML, render(all, today), 'utf8');

  const newErrs = fresh.filter((r) => r.kind !== 'assumption');
  console.log(`scanned ${days}d — ${fresh.length} new records (${newErrs.length} errors, ${fresh.length - newErrs.length} assumptions), ${all.length} total`);
  for (const r of newErrs.slice(0, 8)) console.log(`  [${r.bucket}] ${r.text.slice(0, 110)}`);
  console.log(OUT_HTML);

  if (argv.includes('--open')) {
    try { cp.execFileSync('cmd', ['/c', 'start', '', OUT_HTML.replace(/\//g, '\\')], { stdio: 'ignore' }); } catch {}
  }
}

main();
