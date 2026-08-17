#!/usr/bin/env node
'use strict';
/*
 * daily — Wes's daily error log.
 *
 * The habit (Fable 5, 2026-08-16): ten minutes a day writing down what you got
 * wrong. Not feelings, not gratitude. What did I predict that didn't happen?
 * What did I believe yesterday that turned out off? Where did I waste effort
 * because my assumption was wrong?
 *
 * The design decision that makes this work instead of becoming a diary:
 * YESTERDAY'S BELIEF HAS TO BE ON RECORD BEFORE YOU SCORE IT. A "what did I get
 * wrong" box on its own is answered from hindsight, and hindsight always makes
 * you look reasonable. So every night ends by writing 1-3 predictions, and the
 * next night opens by scoring them hit/miss/partial. The scoring half is the
 * part that can't be fooled.
 *
 * ADHD rules this page obeys: one screen, nothing is required, yesterday's
 * predictions are pre-filled so you never face a blank page, Ctrl+Enter saves,
 * and "nothing today" is a real button. A one-sentence day beats a skipped day.
 *
 * Zero dependencies. Serves on localhost, you type, it saves, it shuts itself
 * down. Nothing listens in the background.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const STORE_DIR = path.join(HOME, '.claude', 'error-log');
const STORE = path.join(STORE_DIR, 'wes.jsonl');
const PORT = Number(process.env.ERRORLOG_PORT || 7841);
const MARKER = '<title>Daily error log</title>';
const IDLE_EXIT_MS = 30 * 60 * 1000;

const QUESTIONS = [
  ['predicted', 'What did I predict that didn’t happen?'],
  ['believed', 'What did I believe yesterday that turned out to be off?'],
  ['wasted', 'Where did I waste effort because my assumption was wrong?'],
];

// ---------------------------------------------------------------- store
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function load() {
  if (!fs.existsSync(STORE)) return [];
  return fs.readFileSync(STORE, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Append-only. A second save on the same date supersedes the first, so the
// newest record per date wins. No rewriting, no lost history.
function latestPerDate(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.date, e);
  return [...m.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function save(entry) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.appendFileSync(STORE, JSON.stringify(entry) + '\n', 'utf8');
}

// Consecutive days ending today or yesterday. Yesterday still counts so an
// evening habit doesn't read as broken before you've done it.
function streak(entries, ref) {
  const days = new Set(entries.map((e) => e.date));
  const day = (n) => new Date(new Date(ref + 'T12:00:00').getTime() + n * 86400000).toISOString().slice(0, 10);
  let start = days.has(ref) ? 0 : days.has(day(-1)) ? -1 : null;
  if (start === null) return 0;
  let n = 0;
  while (days.has(day(start - n))) n++;
  return n;
}

// The predictions to score tonight are the ones written on the most recent
// PREVIOUS day, not today's own (those get scored tomorrow).
function toScore(entries, ref) {
  const prior = latestPerDate(entries).filter((e) => e.date < ref);
  const last = prior[0];
  if (!last || !Array.isArray(last.predictions)) return { from: null, items: [] };
  return { from: last.date, items: last.predictions.filter((p) => p && p.text && p.text.trim()) };
}

// ---------------------------------------------------------------- render
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(entries, ref) {
  const { from, items } = toScore(entries, ref);
  const hist = latestPerDate(entries).slice(0, 14);
  const s = streak(entries, ref);
  const done = entries.some((e) => e.date === ref);

  const scored = items.map((p, i) => `
    <div class="pred" data-id="${esc(p.id || String(i))}" data-text="${esc(p.text)}">
      <div class="ptext">${esc(p.text)}</div>
      <div class="btns">
        <button type="button" class="opt" data-v="hit">Happened</button>
        <button type="button" class="opt" data-v="partial">Partly</button>
        <button type="button" class="opt miss" data-v="miss">Nope</button>
      </div>
      <input class="pnote" placeholder="If it missed — what was actually true? (optional)">
    </div>`).join('');

  const rows = hist.map((e) => {
    const misses = (e.scored || []).filter((x) => x.result === 'miss').length;
    const bits = [e.wrong && e.wrong.predicted, e.wrong && e.wrong.believed, e.wrong && e.wrong.wasted].filter(Boolean);
    return `<details><summary><b>${esc(e.date)}</b> ${e.skipped ? '<span class="tag">skipped</span>' : ''}
      ${misses ? `<span class="tag bad">${misses} missed</span>` : ''}
      <span class="tag dim">${(e.predictions || []).length} predictions</span></summary>
      ${bits.map((b) => `<p>${esc(b)}</p>`).join('') || '<p class="dimtext">no notes</p>'}
      ${(e.scored || []).map((x) => `<p class="dimtext">[${esc(x.result)}] ${esc(x.text)}${x.note ? ' — ' + esc(x.note) : ''}</p>`).join('')}
    </details>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily error log</title><style>
:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--dim:#898781;--border:rgba(255,255,255,.10);--bad:#d63b3b;--good:#0ca30c;--warn:#d6a13b}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:28px 20px 120px;line-height:1.5}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:24px;margin:0 0 2px}.sub{color:var(--dim);font-size:14px;margin-bottom:8px}
.streak{display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px 14px;font-size:13px;color:var(--ink2);margin-bottom:24px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:30px 0 10px;font-weight:600}
.pred{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px}
.ptext{font-size:16px;margin-bottom:10px}
.btns{display:flex;gap:8px;flex-wrap:wrap}
.opt{flex:1;min-width:90px;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--ink2);border-radius:8px;padding:10px;font-size:14px;cursor:pointer;font-family:inherit}
.opt:hover{background:rgba(255,255,255,.1)}
.opt.sel{background:rgba(12,163,12,.22);border-color:var(--good);color:#7fe07f}
.opt.miss.sel{background:rgba(214,59,59,.25);border-color:var(--bad);color:#ff9b9b}
.pnote{display:none;width:100%;margin-top:10px;background:#0d0d0d;border:1px solid var(--border);color:var(--ink);border-radius:8px;padding:10px;font-size:14px;font-family:inherit}
.pnote.show{display:block}
label{display:block;font-size:15px;color:var(--ink2);margin:16px 0 6px}
textarea{width:100%;min-height:64px;background:var(--surface);border:1px solid var(--border);color:var(--ink);border-radius:10px;padding:12px;font-size:15px;font-family:inherit;resize:vertical}
textarea:focus,input:focus{outline:2px solid #5b9bd5;outline-offset:1px}
input.pred-in{width:100%;background:var(--surface);border:1px solid var(--border);color:var(--ink);border-radius:10px;padding:12px;font-size:15px;font-family:inherit;margin-bottom:8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(13,13,13,.96);border-top:1px solid var(--border);padding:14px 20px;display:flex;gap:12px;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.save{background:#e07a4a;border:0;color:#160b05;font-weight:600;border-radius:10px;padding:12px 28px;font-size:15px;cursor:pointer;font-family:inherit}
.skip{background:transparent;border:1px solid var(--border);color:var(--dim);border-radius:10px;padding:12px 18px;font-size:14px;cursor:pointer;font-family:inherit}
.hint{color:var(--dim);font-size:12px}
details{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:6px}
summary{cursor:pointer;font-size:14px;color:var(--ink2)}
details p{font-size:13px;color:var(--ink2);margin:8px 0}
.dimtext{color:var(--dim)!important;font-size:12px!important}
.tag{font-size:11px;background:rgba(255,255,255,.08);color:var(--dim);border-radius:999px;padding:2px 8px;margin-left:6px}
.tag.bad{background:rgba(214,59,59,.2);color:#ff9b9b}.tag.dim{opacity:.7}
.empty{color:var(--dim);font-size:14px;font-style:italic}
.note{color:var(--dim);font-size:12px;max-width:66ch}
#done{display:none;text-align:center;padding:60px 0}#done h1{font-size:28px}
</style></head><body><div class="wrap">
<div id="form">
<h1>Daily error log</h1>
<div class="sub">${esc(ref)}${done ? ' &mdash; already saved today, saving again replaces it' : ''}</div>
<div class="streak">${s > 0 ? `${s} day${s === 1 ? '' : 's'} in a row` : 'First entry'}</div>

<h2>1 &middot; Score what you expected${from ? ` on ${esc(from)}` : ''}</h2>
${items.length ? scored : '<div class="empty">Nothing to score yet. Whatever you write in step 3 shows up here tomorrow.</div>'}

<h2>2 &middot; What did you get wrong today?</h2>
${QUESTIONS.map(([k, q]) => `<label for="${k}">${q}</label><textarea id="${k}" name="${k}"></textarea>`).join('')}

<h2>3 &middot; What do you expect tomorrow?</h2>
<p class="note">Be specific enough to be wrong. "The Stripe webhook fix will make the checkout work" beats "make progress on billing." This is the part tomorrow scores.</p>
<input class="pred-in" placeholder="I expect…">
<input class="pred-in" placeholder="I expect… (optional)">
<input class="pred-in" placeholder="I expect… (optional)">

<h2>Recent</h2>
${rows || '<div class="empty">No entries yet.</div>'}
</div>

<div id="done"><h1>Saved.</h1><p class="sub" id="donemsg"></p><p class="hint">You can close this tab.</p></div>
</div>
<div class="bar" id="bar">
  <button class="save" id="saveBtn">Save</button>
  <button class="skip" id="skipBtn">Nothing today</button>
  <span class="hint">Ctrl+Enter</span>
</div>
<script>
document.querySelectorAll('.pred').forEach(function(p){
  p.querySelectorAll('.opt').forEach(function(b){
    b.addEventListener('click', function(){
      p.querySelectorAll('.opt').forEach(function(x){ x.classList.remove('sel'); });
      b.classList.add('sel');
      p.dataset.result = b.dataset.v;
      p.querySelector('.pnote').classList.toggle('show', b.dataset.v !== 'hit');
    });
  });
});
function collect(skipped){
  var scored = [].map.call(document.querySelectorAll('.pred'), function(p){
    return { id: p.dataset.id, text: p.dataset.text, result: p.dataset.result || 'unscored', note: p.querySelector('.pnote').value.trim() };
  });
  var wrong = {};
  ${JSON.stringify(QUESTIONS.map((q) => q[0]))}.forEach(function(k){ wrong[k] = document.getElementById(k).value.trim(); });
  var predictions = [].map.call(document.querySelectorAll('.pred-in'), function(i, n){
    return { id: String(Date.now()) + '-' + n, text: i.value.trim() };
  }).filter(function(p){ return p.text; });
  return { skipped: !!skipped, scored: scored, wrong: wrong, predictions: predictions };
}
function send(skipped){
  document.getElementById('saveBtn').disabled = true;
  fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect(skipped)) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      document.getElementById('form').style.display = 'none';
      document.getElementById('bar').style.display = 'none';
      document.getElementById('done').style.display = 'block';
      document.getElementById('donemsg').textContent = d.streak + ' days in a row. ' + d.predictions + ' predictions to score tomorrow.';
    })
    .catch(function(){ document.getElementById('saveBtn').disabled = false; alert('Save failed - is the server still running?'); });
}
document.getElementById('saveBtn').addEventListener('click', function(){ send(false); });
document.getElementById('skipBtn').addEventListener('click', function(){ send(true); });
document.addEventListener('keydown', function(e){ if (e.ctrlKey && e.key === 'Enter') send(false); });
var first = document.querySelector('.opt') || document.getElementById('predicted');
if (first) first.focus();
</script></body></html>`;
}

// ---------------------------------------------------------------- selftest
function selftest() {
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

  const e = (date, predictions) => ({ date, predictions: (predictions || []).map((t, i) => ({ id: date + i, text: t })) });

  ok('streak counts back from today', streak([e('2026-08-16'), e('2026-08-15'), e('2026-08-14')], '2026-08-16') === 3);
  ok('gap breaks the streak', streak([e('2026-08-16'), e('2026-08-14')], '2026-08-16') === 1);
  ok('yesterday still counts', streak([e('2026-08-15'), e('2026-08-14')], '2026-08-16') === 2);
  ok('stale entry is no streak', streak([e('2026-08-10')], '2026-08-16') === 0);
  ok('empty is zero', streak([], '2026-08-16') === 0);

  const set = [e('2026-08-14', ['old one']), e('2026-08-15', ['a', 'b']), e('2026-08-16', ['todays'])];
  const ts = toScore(set, '2026-08-16');
  ok('scores the previous day, not today', ts.from === '2026-08-15');
  ok('scores both predictions', ts.items.length === 2);
  ok('no prior day -> nothing to score', toScore([e('2026-08-16', ['x'])], '2026-08-16').items.length === 0);

  const dup = latestPerDate([{ date: '2026-08-16', v: 1 }, { date: '2026-08-16', v: 2 }]);
  ok('newest save per date wins', dup.length === 1 && dup[0].v === 2);

  ok('blank predictions dropped', toScore([e('2026-08-15', ['real', '  '])], '2026-08-16').items.length === 1);
  ok('page renders with no history', page([], '2026-08-16').includes('Daily error log'));
  ok('page renders yesterdays prediction', page([e('2026-08-15', ['ship the thing'])], '2026-08-16').includes('ship the thing'));

  // L1: prove the check can fail. A broken streak function must not pass.
  const brokenStreak = (es) => es.length;
  ok('negative control: naive streak would fail the gap test', brokenStreak([e('2026-08-16'), e('2026-08-14')]) !== 1);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- server
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const ref = today();
  let idle;
  const resetIdle = (server) => {
    clearTimeout(idle);
    idle = setTimeout(() => { console.log('idle, exiting'); server.close(); process.exit(0); }, IDLE_EXIT_MS);
  };

  const server = http.createServer((req, res) => {
    resetIdle(server);
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      const body = page(load(), ref);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (req.method === 'POST' && req.url === '/save') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let d;
        try { d = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{}'); }
        const entry = {
          date: ref,
          ts: new Date().toISOString(),
          skipped: !!d.skipped,
          scored: Array.isArray(d.scored) ? d.scored : [],
          wrong: d.wrong && typeof d.wrong === 'object' ? d.wrong : {},
          predictions: Array.isArray(d.predictions) ? d.predictions : [],
        };
        save(entry);
        const all = load();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, streak: streak(latestPerDate(all), ref), predictions: entry.predictions.length }));
        console.log(`saved ${ref} — ${entry.predictions.length} predictions, ${entry.scored.filter((x) => x.result === 'miss').length} missed`);
        setTimeout(() => { server.close(); process.exit(0); }, 1500);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  server.on('error', (e) => {
    // A busy port is NOT proof that the busy thing is us. Caught on 2026-08-16:
    // 7842 was a Next.js dev server and this branch cheerfully opened a browser
    // to someone else's app. Probe for our own marker before claiming it.
    if (e.code === 'EADDRINUSE') {
      http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; if (b.length > 4000) r.destroy(); });
        r.on('end', () => finishBusy(b.includes(MARKER)));
      }).on('error', () => finishBusy(false)).on('timeout', function () { this.destroy(); finishBusy(false); });
      return;
    }
    console.error(e.message);
    process.exit(1);
  });

  function finishBusy(isOurs) {
    if (isOurs) { console.log(`already open on ${PORT}`); openBrowser(); return process.exit(0); }
    console.error(`port ${PORT} is taken by something else. Set ERRORLOG_PORT to a free port and retry.`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`daily error log → http://localhost:${PORT}`);
    resetIdle(server);
    if (!argv.includes('--no-open')) openBrowser();
  });
}

function openBrowser() {
  try { cp.execFileSync('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { stdio: 'ignore' }); } catch {}
}

main();
