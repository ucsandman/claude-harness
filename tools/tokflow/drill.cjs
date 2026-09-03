// drill.cjs — second pass: fix tool_use counting, identify attachment kinds, Read size drivers,
// date-split the SessionStart hooks (pre/post 2026-09-02 prune), and Agent spawn types.
const fs = require('fs'), path = require('path'), readline = require('readline');
const ROOT = 'C:/Users/sandm/.claude/projects';
const CUTOFF = Date.parse('2026-08-26T00:00:00Z');
const MAXSZ = 200 * 1024 * 1024;

const files = [];
for (const slug of fs.readdirSync(ROOT)) {
  const sdir = path.join(ROOT, slug);
  let entries; try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const p = path.join(sdir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      let f; try { f = fs.statSync(p); } catch { continue; }
      if (f.mtimeMs >= CUTOFF && f.size <= MAXSZ) files.push({ file: p, slug, sid: e.name.slice(0, -6), sub: false });
    } else if (e.isDirectory()) {
      const sa = path.join(p, 'subagents');
      let l; try { l = fs.readdirSync(sa); } catch { continue; }
      for (const af of l) {
        if (!af.endsWith('.jsonl')) continue;
        const ap = path.join(sa, af);
        let f; try { f = fs.statSync(ap); } catch { continue; }
        if (f.mtimeMs >= CUTOFF && f.size <= MAXSZ) files.push({ file: ap, slug, sid: e.name, sub: true, af });
      }
    }
  }
}

const toolUse = new Map();          // true count, no message dedupe
const attachKinds = new Map();      // attachment.type -> {n, bytes}
const skillListingByDay = new Map();
const hookByDay = new Map();        // 'hookgroup|day' -> {n,bytes}
const bigReads = [];                // {bytes, path}
const readBuckets = { '<=4KB': 0, '4-20KB': 0, '20-100KB': 0, '100-400KB': 0, '>400KB': 0 };
const readBucketBytes = { '<=4KB': 0, '4-20KB': 0, '20-100KB': 0, '100-400KB': 0, '>400KB': 0 };
const agentTypes = new Map();       // subagent_type -> n
const bashResBuckets = { '<=1KB': 0, '1-5KB': 0, '5-20KB': 0, '>20KB': 0 };
let readTotal = 0, readN = 0;
const HOOKNAMES = [
  ['ponytail', /PONYTAIL MODE ACTIVE/],
  ['capability-primer', /Claude Code — Capability Self-Awareness Card|claude-code-capabilities/],
  ['vercel-plugin', /Vercel Plugin Session Context|Vercel CLI is not installed/],
  ['superpowers', /You have superpowers/],
  ['creds-vault', /creds vault is installed/],
  ['fable-delegate-guard', /\[fable-delegate-guard\]/],
  ['session-budget', /\[session-budget\]/],
  ['docs-scan-tip', /Run \/docs-scan/],
  ['dev-server-guard', /dev-server-guard/],
];

function bb(c) {
  if (c == null) return 0;
  if (typeof c === 'string') return Buffer.byteLength(c, 'utf8');
  if (Array.isArray(c)) return c.reduce((a, b) => a + bb(b), 0);
  if (typeof c === 'object') return typeof c.text === 'string' ? Buffer.byteLength(c.text, 'utf8') : Buffer.byteLength(JSON.stringify(c), 'utf8');
  return 0;
}

(async () => {
  for (const ent of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(ent.file), crlfDelay: Infinity });
    const idName = new Map(), idInput = new Map();
    for await (const line of rl) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const day = (o.timestamp || '').slice(0, 10);

      if (o.type === 'attachment' && o.attachment) {
        const at = o.attachment;
        const txt = typeof at.content === 'string' ? at.content : (typeof at.stdout === 'string' ? at.stdout : (at.content ? JSON.stringify(at.content) : ''));
        const b = Buffer.byteLength(txt || '', 'utf8');
        const k = at.type || '?';
        const a = attachKinds.get(k) || { n: 0, bytes: 0, sample: (txt || '').replace(/\s+/g, ' ').slice(0, 110) };
        a.n++; a.bytes += b; attachKinds.set(k, a);
        if (k === 'skill_listing' || k === 'workflow_listing') {
          const d = skillListingByDay.get(day) || { n: 0, bytes: 0 };
          d.n++; d.bytes += b; skillListingByDay.set(day, d);
        }
        for (const [nm, re] of HOOKNAMES) {
          if (re.test(txt || '')) {
            const key = nm + '|' + day;
            const d = hookByDay.get(key) || { n: 0, bytes: 0 };
            d.n++; d.bytes += b; hookByDay.set(key, d);
          }
        }
        continue;
      }

      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const blk of o.message.content) {
          if (blk.type === 'tool_use') {
            idName.set(blk.id, blk.name);
            toolUse.set(blk.name, (toolUse.get(blk.name) || 0) + 1);
            if (blk.name === 'Agent' || blk.name === 'Task') {
              const t = (blk.input && (blk.input.subagent_type || blk.input.agent_type)) || 'unspecified';
              const m = (blk.input && blk.input.model) || '?';
              const key = t + ' / model=' + m;
              agentTypes.set(key, (agentTypes.get(key) || 0) + 1);
            }
            if (blk.name === 'Read' && blk.input) idInput.set(blk.id, String(blk.input.file_path || ''));
          }
        }
        continue;
      }

      if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
        for (const blk of o.message.content) {
          if (blk.type !== 'tool_result') continue;
          const nm = idName.get(blk.tool_use_id) || 'unknown';
          const b = bb(blk.content);
          if (nm === 'Read') {
            readTotal += b; readN++;
            const bk = b <= 4096 ? '<=4KB' : b <= 20480 ? '4-20KB' : b <= 102400 ? '20-100KB' : b <= 409600 ? '100-400KB' : '>400KB';
            readBuckets[bk]++; readBucketBytes[bk] += b;
            if (b > 150000) bigReads.push({ b, p: idInput.get(blk.tool_use_id) || '?', sid: ent.sid.slice(0, 8) });
          } else if (nm === 'Bash') {
            const bk = b <= 1024 ? '<=1KB' : b <= 5120 ? '1-5KB' : b <= 20480 ? '5-20KB' : '>20KB';
            bashResBuckets[bk]++;
          }
        }
      }
    }
  }

  const fmt = n => Math.round(n).toLocaleString('en-US');
  const L = [];
  const say = (...a) => L.push(a.join(' '));

  say('=== TRUE TOOL_USE COUNTS (no message dedupe) ===');
  const tu = [...toolUse.entries()].sort((a, b) => b[1] - a[1]);
  say('total tool calls = ' + fmt(tu.reduce((a, b) => a + b[1], 0)));
  for (const [k, v] of tu.slice(0, 22)) say(`  ${k.padEnd(48)} ${String(v).padStart(6)}`);
  const mcpNames = tu.filter(x => x[0].startsWith('mcp__'));
  say(`  mcp__ calls total=${fmt(mcpNames.reduce((a, b) => a + b[1], 0))} across ${mcpNames.length} distinct mcp tools`);

  say('');
  say('=== ATTACHMENT KINDS (all injected non-assistant context) ===');
  for (const [k, v] of [...attachKinds.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    say(`  ${k.padEnd(24)} n=${String(v.n).padStart(6)} bytes=${fmt(v.bytes).padStart(11)} (~${fmt(v.bytes / 4)} tok) mean=${fmt(v.bytes / v.n)}  :: ${v.sample.slice(0, 90)}`);
  }

  say('');
  say('=== skill_listing / workflow_listing BY DAY ===');
  for (const [k, v] of [...skillListingByDay.entries()].sort()) say(`  ${k} n=${String(v.n).padStart(4)} bytes=${fmt(v.bytes).padStart(10)} mean=${fmt(v.bytes / v.n)}`);

  say('');
  say('=== NAMED SESSION HOOKS BY DAY (n injections / bytes) ===');
  const names = [...new Set([...hookByDay.keys()].map(k => k.split('|')[0]))];
  const days = [...new Set([...hookByDay.keys()].map(k => k.split('|')[1]))].sort();
  say('hook'.padEnd(24) + days.map(d => d.slice(5)).join('   '));
  for (const nm of names) {
    say(nm.padEnd(24) + days.map(d => { const v = hookByDay.get(nm + '|' + d); return v ? String(v.n).padStart(5) : '    .'; }).join('   '));
  }
  say('bytes per hook total:');
  for (const nm of names) {
    let n = 0, b = 0; for (const d of days) { const v = hookByDay.get(nm + '|' + d); if (v) { n += v.n; b += v.bytes; } }
    say(`  ${nm.padEnd(24)} n=${String(n).padStart(4)} bytes=${fmt(b).padStart(10)} (~${fmt(b / 4)} tok) mean=${fmt(b / n)} tok_each=${fmt(b / n / 4)}`);
  }

  say('');
  say('=== READ RESULT SIZE DISTRIBUTION ===');
  say(`Read results n=${fmt(readN)} total=${fmt(readTotal)} bytes (~${fmt(readTotal / 4)} tok)`);
  for (const k of Object.keys(readBuckets)) say(`  ${k.padEnd(10)} n=${String(readBuckets[k]).padStart(5)} bytes=${fmt(readBucketBytes[k]).padStart(12)} (${(100 * readBucketBytes[k] / readTotal).toFixed(1)}% of Read bytes)`);
  say('Bash result sizes: ' + JSON.stringify(bashResBuckets));
  say('');
  say('top 25 single Read results:');
  bigReads.sort((a, b) => b.b - a.b);
  for (const r of bigReads.slice(0, 25)) say(`  ${fmt(r.b).padStart(9)}B (~${fmt(r.b / 4)} tok) ${r.sid} ${r.p.slice(-95)}`);
  say(`Reads >150KB: n=${bigReads.length} bytes=${fmt(bigReads.reduce((a, b) => a + b.b, 0))} (~${fmt(bigReads.reduce((a, b) => a + b.b, 0) / 4)} tok)`);

  say('');
  say('=== Agent/Task SPAWN TYPES ===');
  for (const [k, v] of [...agentTypes.entries()].sort((a, b) => b[1] - a[1])) say(`  ${k.padEnd(50)} ${v}`);

  const out = L.join('\n');
  fs.writeFileSync(path.join(__dirname, 'drill-report.txt'), out);
  console.log(out);
})();
