// pass4.cjs — (a) first-turn fixed context by day (prune effect / current baseline)
// (b) subagent first-turn context joined to agent type via .meta.json
// (c) cache_creation spikes vs idle gap since previous turn
// (d) skill_listing size main-loop vs subagent
const fs = require('fs'), path = require('path'), readline = require('readline');
const ROOT = 'C:/Users/sandm/.claude/projects';
const CUTOFF = Date.parse('2026-08-26T00:00:00Z');

const mains = [], subs = [];
for (const slug of fs.readdirSync(ROOT)) {
  const sdir = path.join(ROOT, slug);
  let entries; try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const p = path.join(sdir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      let f; try { f = fs.statSync(p); } catch { continue; }
      if (f.mtimeMs >= CUTOFF && f.size <= 200e6) mains.push({ file: p, sid: e.name.slice(0, -6), slug });
    } else if (e.isDirectory()) {
      const sa = path.join(p, 'subagents');
      let l; try { l = fs.readdirSync(sa); } catch { continue; }
      for (const af of l) { if (!af.endsWith('.jsonl')) continue; const ap = path.join(sa, af);
        let f; try { f = fs.statSync(ap); } catch { continue; }
        if (f.mtimeMs >= CUTOFF && f.size <= 200e6) subs.push({ file: ap, sid: e.name, af, meta: ap.replace(/\.jsonl$/, '.meta.json') }); }
    }
  }
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const L = []; const say = (...a) => L.push(a.join(' '));

(async () => {
  // ---- (a) main sessions: first turn by day, plus skill_listing size ----
  const byDay = new Map();
  const gapBuckets = { '<5m': { n: 0, cc: 0 }, '5m-1h': { n: 0, cc: 0 }, '1h-6h': { n: 0, cc: 0 }, '>6h': { n: 0, cc: 0 } };
  let ccTotalAfter1 = 0;
  const skillListMain = [], skillListSub = [];
  for (const ent of mains) {
    const rl = readline.createInterface({ input: fs.createReadStream(ent.file), crlfDelay: Infinity });
    const seen = new Set(); let turn = 0, first = 0, day = null, prevTs = null, cmdStart = false, sawUser = false;
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'attachment' && o.attachment && o.attachment.type === 'skill_listing') {
        const t = typeof o.attachment.content === 'string' ? o.attachment.content : JSON.stringify(o.attachment.content || '');
        skillListMain.push(Buffer.byteLength(t, 'utf8'));
      }
      if (o.type === 'user' && !sawUser && typeof (o.message && o.message.content) === 'string') { sawUser = true; if (/<command-name>|<command-message>/.test(o.message.content)) cmdStart = true; }
      if (o.type !== 'assistant' || !o.message) continue;
      const m = o.message, mid = m.id || o.uuid;
      if (seen.has(mid)) continue; seen.add(mid);
      const u = m.usage || {};
      const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const ts = Date.parse(o.timestamp || 0);
      turn++;
      if (turn === 1) { first = total; day = (o.timestamp || '').slice(0, 10); }
      else {
        const cc = u.cache_creation_input_tokens || 0;
        ccTotalAfter1 += cc;
        const gap = prevTs ? (ts - prevTs) / 1000 : 0;
        const b = gap < 300 ? '<5m' : gap < 3600 ? '5m-1h' : gap < 21600 ? '1h-6h' : '>6h';
        gapBuckets[b].n++; gapBuckets[b].cc += cc;
      }
      prevTs = ts;
    }
    if (turn > 0 && day) {
      const d = byDay.get(day) || { clean: [], cmd: [] };
      (cmdStart ? d.cmd : d.clean).push(first); byDay.set(day, d);
    }
  }

  say('=== (A) MAIN-LOOP FIRST-TURN CONTEXT BY DAY (clean starts only) ===');
  say('day          n   mean      p50       min      max');
  for (const [k, v] of [...byDay.entries()].sort()) {
    if (!v.clean.length) continue;
    say(`${k}  ${String(v.clean.length).padStart(3)} ${fmt(mean(v.clean)).padStart(8)} ${fmt(pct(v.clean, .5)).padStart(9)} ${fmt(Math.min(...v.clean)).padStart(9)} ${fmt(Math.max(...v.clean)).padStart(9)}`);
  }

  say('');
  say('=== (C) cache_creation AFTER TURN 1, BY IDLE GAP SINCE PREVIOUS TURN ===');
  say(`total cc after turn 1 (main sessions) = ${fmt(ccTotalAfter1)}`);
  for (const [k, v] of Object.entries(gapBuckets)) say(`  gap ${k.padEnd(7)} turns=${String(v.n).padStart(6)} cache_creation=${fmt(v.cc).padStart(12)} (${(100 * v.cc / (ccTotalAfter1 || 1)).toFixed(1)}%) mean_cc_per_turn=${fmt(v.cc / (v.n || 1))}`);

  // ---- (b) subagents joined to type ----
  const byType = new Map();
  for (const ent of subs) {
    let type = 'unknown', model = 'unknown';
    try {
      const meta = JSON.parse(fs.readFileSync(ent.meta, 'utf8'));
      type = meta.agentType || meta.subagent_type || meta.type || meta.name || 'unknown';
      model = meta.model || 'unknown';
    } catch { }
    const rl = readline.createInterface({ input: fs.createReadStream(ent.file), crlfDelay: Infinity });
    const seen = new Set(); let turn = 0, first = 0, mdl = 'unknown', totalTok = 0;
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'attachment' && o.attachment && o.attachment.type === 'skill_listing') {
        const t = typeof o.attachment.content === 'string' ? o.attachment.content : JSON.stringify(o.attachment.content || '');
        skillListSub.push(Buffer.byteLength(t, 'utf8'));
      }
      if (o.type !== 'assistant' || !o.message) continue;
      const m = o.message, mid = m.id || o.uuid;
      if (seen.has(mid)) continue; seen.add(mid);
      const u = m.usage || {};
      const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      totalTok += tot + (u.output_tokens || 0);
      turn++; if (turn === 1) { first = tot; mdl = m.model || model; }
    }
    if (!turn) continue;
    const key = `${type} / ${mdl}`;
    const g = byType.get(key) || { n: 0, firsts: [], total: 0, turns: 0 };
    g.n++; g.firsts.push(first); g.total += totalTok; g.turns += turn; byType.set(key, g);
  }

  say('');
  say('=== (B) SUBAGENT SPAWNS BY AGENT TYPE (from .meta.json) ===');
  say('type / model                                 spawns  first_ctx_mean  p50      min      turns  total_tokens');
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1].total - a[1].total)) {
    say(`${k.slice(0, 42).padEnd(42)} ${String(v.n).padStart(5)} ${fmt(mean(v.firsts)).padStart(14)} ${fmt(pct(v.firsts, .5)).padStart(8)} ${fmt(Math.min(...v.firsts)).padStart(8)} ${String(v.turns).padStart(7)} ${fmt(v.total).padStart(13)}`);
  }
  // lean vs general
  const lean = [], gen = [];
  for (const [k, v] of byType) {
    if (/haiku-scout|sonnet-implementer|opus-owner|advisor/.test(k)) lean.push(...v.firsts); else gen.push(...v.firsts);
  }
  say(`LEAN types (haiku-scout/sonnet-implementer/opus-owner/advisor): n=${lean.length} mean_first_ctx=${fmt(mean(lean))}`);
  say(`OTHER types (general-purpose etc):                              n=${gen.length} mean_first_ctx=${fmt(mean(gen))}`);
  say(`delta per spawn = ${fmt(mean(gen) - mean(lean))} tokens`);

  say('');
  say('=== (D) skill_listing SIZE: main-loop vs subagent ===');
  say(`main-loop  n=${skillListMain.length} mean=${fmt(mean(skillListMain))}B (~${fmt(mean(skillListMain) / 4)} tok) p50=${fmt(pct(skillListMain, .5))}B max=${fmt(Math.max(0, ...skillListMain))}B`);
  say(`subagent   n=${skillListSub.length} mean=${fmt(mean(skillListSub))}B (~${fmt(mean(skillListSub) / 4)} tok) p50=${fmt(pct(skillListSub, .5))}B max=${fmt(Math.max(0, ...skillListSub))}B`);

  const out = L.join('\n');
  fs.writeFileSync(path.join(__dirname, 'pass4-report.txt'), out);
  console.log(out);
})();
