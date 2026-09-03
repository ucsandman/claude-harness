// pass3.cjs — correct image vs text tool_result accounting; attribute injected hook text by
// attachment kind + hookEvent; measure per-session injection repeat counts and turns-after.
const fs = require('fs'), path = require('path'), readline = require('readline');
const ROOT = 'C:/Users/sandm/.claude/projects';
const CUTOFF = Date.parse('2026-08-26T00:00:00Z');

const files = [];
for (const slug of fs.readdirSync(ROOT)) {
  const sdir = path.join(ROOT, slug);
  let entries; try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const p = path.join(sdir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      let f; try { f = fs.statSync(p); } catch { continue; }
      if (f.mtimeMs >= CUTOFF && f.size <= 200e6) files.push({ file: p, sid: e.name.slice(0, -6), sub: false });
    } else if (e.isDirectory()) {
      const sa = path.join(p, 'subagents');
      let l; try { l = fs.readdirSync(sa); } catch { continue; }
      for (const af of l) { if (!af.endsWith('.jsonl')) continue; const ap = path.join(sa, af);
        let f; try { f = fs.statSync(ap); } catch { continue; }
        if (f.mtimeMs >= CUTOFF && f.size <= 200e6) files.push({ file: ap, sid: e.name, sub: true, af }); }
    }
  }
}

const textRes = new Map();   // tool -> {n,sum,vals}
let imgN = 0, imgBytes = 0;
const imgByTool = new Map();
const inj = new Map();       // 'kind|event|name' -> {n,bytes,perSession:Map(sid->n)}
const sessionInjRepeat = new Map(); // name -> array of per-session counts
let mainTurnsBySession = new Map();

const NAMED = [
  ['skill_listing-catalog', /^- [a-z0-9-]+: |^- adversarial-review/],
  ['ponytail', /PONYTAIL MODE ACTIVE/],
  ['capability-primer', /claude-code-capabilities|Capability Self-Awareness Card/],
  ['vercel-plugin', /Vercel Plugin Session Context|Vercel CLI is not installed/],
  ['superpowers', /You have superpowers/],
  ['session-budget', /\[session-budget\]/],
  ['creds-vault', /creds vault is installed/],
  ['fable-delegate-guard', /\[fable-delegate-guard\]/],
  ['agnostic-harness', /AGNOSTIC-HARNESS|Agnostic Harness/],
];
function nameOf(t) { for (const [n, re] of NAMED) if (re.test(t)) return n; return 'other'; }

function measure(c, tool) {
  // returns text bytes; counts image blocks separately
  let tb = 0;
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === 'string') { tb += Buffer.byteLength(x, 'utf8'); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (x.type === 'image') {
        const d = (x.source && x.source.data) || '';
        imgN++; imgBytes += d.length;
        const g = imgByTool.get(tool) || { n: 0, b64: 0 }; g.n++; g.b64 += d.length; imgByTool.set(tool, g);
        return;
      }
      if (typeof x.text === 'string') { tb += Buffer.byteLength(x.text, 'utf8'); return; }
      tb += Buffer.byteLength(JSON.stringify(x), 'utf8');
    }
  };
  walk(c);
  return tb;
}

(async () => {
  for (const ent of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(ent.file), crlfDelay: Infinity });
    const idName = new Map();
    const seen = new Set();
    let turns = 0;
    const localInj = new Map();
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'attachment' && o.attachment) {
        const at = o.attachment;
        const txt = typeof at.content === 'string' ? at.content : (typeof at.stdout === 'string' ? at.stdout : (at.content ? JSON.stringify(at.content) : ''));
        const b = Buffer.byteLength(txt || '', 'utf8');
        if (!b) continue;
        const ev = at.hookEvent || '-';
        const nm = nameOf(txt);
        const key = `${at.type}|${ev}|${nm}`;
        const g = inj.get(key) || { n: 0, bytes: 0, sess: new Set(), sample: txt.replace(/\s+/g, ' ').slice(0, 80) };
        g.n++; g.bytes += b; g.sess.add(ent.sid + (ent.af || '')); inj.set(key, g);
        localInj.set(nm, (localInj.get(nm) || 0) + 1);
        continue;
      }
      if (o.type === 'assistant' && o.message) {
        const m = o.message;
        if (Array.isArray(m.content)) for (const blk of m.content) if (blk.type === 'tool_use') idName.set(blk.id, blk.name);
        const mid = m.id || o.uuid;
        if (!seen.has(mid)) { seen.add(mid); turns++; }
        continue;
      }
      if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
        for (const blk of o.message.content) {
          if (blk.type !== 'tool_result') continue;
          const nm = idName.get(blk.tool_use_id) || 'unknown';
          const tb = measure(blk.content, nm);
          let g = textRes.get(nm); if (!g) { g = { n: 0, sum: 0, vals: [] }; textRes.set(nm, g); }
          g.n++; g.sum += tb; if (g.vals.length < 20000) g.vals.push(tb);
        }
      }
    }
    if (!ent.sub) mainTurnsBySession.set(ent.sid, turns);
    for (const [k, v] of localInj) { const a = sessionInjRepeat.get(k) || []; a.push(v); sessionInjRepeat.set(k, a); }
  }

  const fmt = n => Math.round(n).toLocaleString('en-US');
  const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const L = []; const say = (...a) => L.push(a.join(' '));

  say('=== TOOL_RESULT: TEXT BYTES ONLY (images excluded) ===');
  const rows = [...textRes.entries()].map(([k, v]) => ({ k, n: v.n, sum: v.sum, mean: v.sum / v.n, p50: pct(v.vals, .5), p95: pct(v.vals, .95), max: Math.max(...v.vals) })).sort((a, b) => b.sum - a.sum);
  const tot = rows.reduce((a, b) => a + b.sum, 0);
  say(`TOTAL text tool_result bytes=${fmt(tot)} (~${fmt(tot / 4)} tok) across ${fmt(rows.reduce((a, b) => a + b.n, 0))} results`);
  say('tool                                  n      total_B    ~tok      mean     p50      p95      max');
  for (const r of rows.slice(0, 16)) say(`${r.k.slice(0, 36).padEnd(36)} ${String(r.n).padStart(5)} ${fmt(r.sum).padStart(12)} ${fmt(r.sum / 4).padStart(9)} ${fmt(r.mean).padStart(8)} ${fmt(r.p50).padStart(7)} ${fmt(r.p95).padStart(8)} ${fmt(r.max).padStart(8)}`);

  say('');
  say('=== IMAGES IN TOOL RESULTS (base64 chars; model cost ~1.1-1.6k tok each, NOT bytes/4) ===');
  say(`total image blocks=${fmt(imgN)} base64_chars=${fmt(imgBytes)}  est_model_tokens@1500ea=${fmt(imgN * 1500)}`);
  for (const [k, v] of [...imgByTool.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) say(`  ${k.padEnd(44)} n=${String(v.n).padStart(5)} b64_chars=${fmt(v.b64)}`);

  say('');
  say('=== INJECTED CONTEXT BY (attachment kind | hookEvent | source) ===');
  const irows = [...inj.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.bytes - a.bytes);
  const itot = irows.reduce((a, b) => a + b.bytes, 0);
  say(`TOTAL injected bytes=${fmt(itot)} (~${fmt(itot / 4)} tok)`);
  say('kind|event|source                                          n   distinct_sess    bytes      ~tok   tok_each');
  for (const r of irows.slice(0, 20)) say(`${r.k.slice(0, 56).padEnd(56)} ${String(r.n).padStart(5)} ${String(r.sess.size).padStart(9)} ${fmt(r.bytes).padStart(11)} ${fmt(r.bytes / 4).padStart(9)} ${fmt(r.bytes / r.n / 4).padStart(8)}`);

  say('');
  say('=== INJECTION REPEATS PER SESSION (how many times one source hits one session) ===');
  for (const [k, arr] of [...sessionInjRepeat.entries()].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, 10)) {
    say(`  ${k.padEnd(24)} sessions=${String(arr.length).padStart(4)} total=${arr.reduce((a, b) => a + b, 0)} mean_per_session=${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)} max=${Math.max(...arr)}`);
  }

  const t = [...mainTurnsBySession.values()];
  say('');
  say(`=== MAIN SESSION LENGTH: n=${t.length} mean_turns=${fmt(t.reduce((a, b) => a + b, 0) / t.length)} p50=${pct(t, .5)} p90=${pct(t, .9)} ===`);
  say(`marginal cost of 1 token added to fixed context = 1 (write) + 0.1 x mean_turns cache-read = ~${(1 + 0.1 * (t.reduce((a, b) => a + b, 0) / t.length)).toFixed(1)} effective tokens/session`);

  const out = L.join('\n');
  fs.writeFileSync(path.join(__dirname, 'pass3-report.txt'), out);
  console.log(out);
})();
