// tokflow.cjs — measure real token flow from Claude Code transcripts since a cutoff date.
// Usage: node tokflow.cjs [ISO-cutoff]  (default 2026-08-26)
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = 'C:/Users/sandm/.claude/projects';
const CUTOFF = Date.parse(process.argv[2] || '2026-08-26T00:00:00Z');
const MAXSZ = 200 * 1024 * 1024;

// ---------- collect files ----------
const mainFiles = [];   // {file, slug, sessionId}
const subFiles = [];    // {file, slug, sessionId, agentFile}
for (const slug of fs.readdirSync(ROOT)) {
  const sdir = path.join(ROOT, slug);
  let st; try { st = fs.statSync(sdir); } catch { continue; }
  if (!st.isDirectory()) continue;
  let entries; try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const p = path.join(sdir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      let f; try { f = fs.statSync(p); } catch { continue; }
      if (f.mtimeMs >= CUTOFF && f.size <= MAXSZ) mainFiles.push({ file: p, slug, sessionId: e.name.replace(/\.jsonl$/, ''), size: f.size });
    } else if (e.isDirectory()) {
      const sa = path.join(p, 'subagents');
      let saEntries; try { saEntries = fs.readdirSync(sa); } catch { continue; }
      for (const af of saEntries) {
        if (!af.endsWith('.jsonl')) continue;
        const ap = path.join(sa, af);
        let f; try { f = fs.statSync(ap); } catch { continue; }
        if (f.mtimeMs >= CUTOFF && f.size <= MAXSZ) subFiles.push({ file: ap, slug, sessionId: e.name, agentFile: af, size: f.size });
      }
    }
  }
}

// ---------- accumulators ----------
const S = {
  filesMain: mainFiles.length, filesSub: subFiles.length,
  bytesMain: mainFiles.reduce((a, b) => a + b.size, 0),
  bytesSub: subFiles.reduce((a, b) => a + b.size, 0),
  linesRead: 0, badLines: 0,
  turnsMain: 0, turnsSub: 0,
  sidechainInMain: 0,
};
const turnsIn = [], turnsCR = [], turnsCC = [], turnsOut = [], turnsThink = [];
let sumIn = 0, sumCR = 0, sumCC = 0, sumOut = 0, sumThink = 0;
const firstTurnClean = [], firstTurnCommand = [];
const perSession = new Map(); // sessionId -> {slug, firstTurn, toolResultBytes, hookBytesPerTurn, turns, cc, promptTurns}
const toolResBytes = new Map(); // name -> array of byte lengths (kept as running stats + sample for p95)
const toolUseCount = new Map();
const hookGroups = new Map(); // key -> {bytes, count, event, hookName, sample}
const sysReminders = new Map();
const spawnByModel = new Map(); // model -> {count, firstIn:[], total}
const ccSpikes = []; // {session, turnIdx, cc, injected:[...]}
let promptTurnsTotal = 0;
const mcpServersCalled = new Set();
let mcpCalls = 0;

function pushStat(map, k, v) {
  let a = map.get(k);
  if (!a) { a = { n: 0, sum: 0, vals: [] }; map.set(k, a); }
  a.n++; a.sum += v;
  if (a.vals.length < 20000) a.vals.push(v);
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function blockBytes(c) {
  if (c == null) return 0;
  if (typeof c === 'string') return Buffer.byteLength(c, 'utf8');
  if (Array.isArray(c)) return c.reduce((a, b) => a + blockBytes(b), 0);
  if (typeof c === 'object') {
    if (typeof c.text === 'string') return Buffer.byteLength(c.text, 'utf8');
    return Buffer.byteLength(JSON.stringify(c), 'utf8');
  }
  return 0;
}

const HOOKISH = /^(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SubagentStop|PreCompact|Notification)/;

async function scan(entry, isSub) {
  const rl = readline.createInterface({ input: fs.createReadStream(entry.file), crlfDelay: Infinity });
  const seenMsg = new Set();       // messageId dedupe for usage
  const toolIdName = new Map();    // tool_use_id -> name
  let firstTurn = null;
  let firstUserIsCommand = false, sawFirstUser = false;
  let turnIdx = 0;
  let sessToolResBytes = 0, sessHookBytes = 0, sessPromptTurns = 0, sessCC = 0, sessTotal = 0;
  let pendingInjected = [];        // injected text seen since last assistant turn
  let firstModel = null;

  for await (const line of rl) {
    S.linesRead++;
    let o; try { o = JSON.parse(line); } catch { S.badLines++; continue; }

    // hook attachments
    if (o.type === 'attachment' && o.attachment) {
      const at = o.attachment;
      const txt = typeof at.content === 'string' ? at.content
        : (typeof at.stdout === 'string' ? at.stdout : (at.content ? JSON.stringify(at.content) : ''));
      if (at.hookName || at.hookEvent) {
        const b = Buffer.byteLength(txt || '', 'utf8');
        const ev = at.hookEvent || (at.hookName || '').split(':')[0];
        const key = (at.hookName || ev) + ' || ' + (txt || '').replace(/\s+/g, ' ').slice(0, 40);
        let g = hookGroups.get(key);
        if (!g) { g = { bytes: 0, count: 0, event: ev, hookName: at.hookName || ev, sample: (txt || '').replace(/\s+/g, ' ').slice(0, 90) }; hookGroups.set(key, g); }
        g.bytes += b; g.count++;
        sessHookBytes += b;
        if (b > 0) pendingInjected.push({ kind: 'hook:' + (at.hookName || ev), bytes: b, head: (txt || '').replace(/\s+/g, ' ').slice(0, 200) });
      } else if (txt) {
        const b = Buffer.byteLength(txt, 'utf8');
        const key = 'attachment:' + (at.type || '?') + ' || ' + txt.replace(/\s+/g, ' ').slice(0, 40);
        let g = sysReminders.get(key);
        if (!g) { g = { bytes: 0, count: 0, sample: txt.replace(/\s+/g, ' ').slice(0, 90) }; sysReminders.set(key, g); }
        g.bytes += b; g.count++;
        if (b > 0) pendingInjected.push({ kind: 'attach:' + (at.type || '?'), bytes: b, head: txt.replace(/\s+/g, ' ').slice(0, 200) });
      }
      continue;
    }

    if (o.type === 'user' && o.message) {
      if (o.isSidechain && !isSub) S.sidechainInMain++;
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const blk of c) {
          if (blk.type === 'tool_result') {
            const b = blockBytes(blk.content);
            const nm = toolIdName.get(blk.tool_use_id) || 'unknown';
            pushStat(toolResBytes, nm, b);
            sessToolResBytes += b;
          } else if (blk.type === 'text' && typeof blk.text === 'string') {
            const t = blk.text;
            const b = Buffer.byteLength(t, 'utf8');
            const flat = t.replace(/\s+/g, ' ');
            if (/^<system-reminder>|<system-reminder>/.test(flat.slice(0, 200)) || HOOKISH.test(flat) || /^\[[a-z-]+guard\]|^\[session-budget\]|^\[batch-guard\]|DashClaw/.test(flat)) {
              const key = 'inline || ' + flat.slice(0, 40);
              let g = sysReminders.get(key);
              if (!g) { g = { bytes: 0, count: 0, sample: flat.slice(0, 90) }; sysReminders.set(key, g); }
              g.bytes += b; g.count++;
              pendingInjected.push({ kind: 'inline-text', bytes: b, head: flat.slice(0, 200) });
            }
          }
        }
      } else if (typeof c === 'string') {
        const flat = c.replace(/\s+/g, ' ');
        if (!o.isMeta) { sessPromptTurns++; promptTurnsTotal++; }
        if (!sawFirstUser) {
          sawFirstUser = true;
          if (/<command-name>|<command-message>|<skill-format>/.test(c)) firstUserIsCommand = true;
        }
        if (/<system-reminder>/.test(flat) || HOOKISH.test(flat)) {
          const key = 'inline || ' + flat.slice(0, 40);
          let g = sysReminders.get(key);
          if (!g) { g = { bytes: 0, count: 0, sample: flat.slice(0, 90) }; sysReminders.set(key, g); }
          g.bytes += Buffer.byteLength(c, 'utf8'); g.count++;
        }
      }
      continue;
    }

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      // map tool_use ids -> names (do this for EVERY line, even deduped ones)
      if (Array.isArray(m.content)) {
        for (const blk of m.content) {
          if (blk.type === 'tool_use') {
            toolIdName.set(blk.id, blk.name);
          }
        }
      }
      const mid = m.id || o.messageId || o.requestId || o.uuid;
      if (seenMsg.has(mid)) continue;
      seenMsg.add(mid);

      // count tool_use once per message
      if (Array.isArray(m.content)) {
        for (const blk of m.content) {
          if (blk.type === 'tool_use') {
            toolUseCount.set(blk.name, (toolUseCount.get(blk.name) || 0) + 1);
            if (blk.name && blk.name.startsWith('mcp__')) {
              mcpCalls++;
              mcpServersCalled.add(blk.name.split('__')[1] || '?');
            }
          }
        }
      }

      const u = m.usage || {};
      const inTok = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
      const out = u.output_tokens || 0;
      const th = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
      const total = inTok + cr + cc;
      if (!firstModel) firstModel = m.model;

      turnIdx++;
      if (isSub) S.turnsSub++; else S.turnsMain++;
      turnsIn.push(inTok); turnsCR.push(cr); turnsCC.push(cc); turnsOut.push(out); turnsThink.push(th);
      sumIn += inTok; sumCR += cr; sumCC += cc; sumOut += out; sumThink += th;
      sessCC += cc; sessTotal += total;

      if (turnIdx === 1) {
        firstTurn = total;
        if (isSub) {
          const mdl = m.model || 'unknown';
          let g = spawnByModel.get(mdl);
          if (!g) { g = { count: 0, firstIn: [], total: 0 }; spawnByModel.set(mdl, g); }
          g.count++; g.firstIn.push(total);
        }
      } else if (cc > 3000) {
        ccSpikes.push({ session: entry.sessionId, sub: isSub ? entry.agentFile : null, turnIdx, cc, cr, injected: pendingInjected.slice(-8) });
      }
      if (isSub) {
        const mdl = m.model || 'unknown';
        let g = spawnByModel.get(mdl);
        if (!g) { g = { count: 0, firstIn: [], total: 0 }; spawnByModel.set(mdl, g); }
        g.total += total + out;
      }
      pendingInjected = [];
      continue;
    }
  }

  if (turnIdx > 0 && !isSub) {
    (firstUserIsCommand ? firstTurnCommand : firstTurnClean).push(firstTurn || 0);
    perSession.set(entry.sessionId, {
      slug: entry.slug, firstTurn: firstTurn || 0, toolResBytes: sessToolResBytes,
      hookBytes: sessHookBytes, turns: turnIdx, promptTurns: sessPromptTurns, cc: sessCC, total: sessTotal, model: firstModel,
    });
  }
}

(async () => {
  for (const f of mainFiles) { try { await scan(f, false); } catch (e) { console.error('ERR', f.file, e.message); } }
  for (const f of subFiles) { try { await scan(f, true); } catch (e) { console.error('ERR', f.file, e.message); } }

  const L = [];
  const say = (...a) => L.push(a.join(' '));
  const fmt = n => Math.round(n).toLocaleString('en-US');

  say('=== (0) SCOPE ===');
  say(`cutoff=${new Date(CUTOFF).toISOString()}  main_files=${S.filesMain} (${fmt(S.bytesMain / 1048576)} MB)  subagent_files=${S.filesSub} (${fmt(S.bytesSub / 1048576)} MB)`);
  say(`lines_parsed=${fmt(S.linesRead)}  bad_lines=${S.badLines}  sidechain_entries_found_in_main_files=${S.sidechainInMain}`);

  say('');
  say('=== (1) SESSIONS AND TURNS ===');
  say(`main_sessions_with_turns=${perSession.size}  main_assistant_turns=${fmt(S.turnsMain)}  subagent_assistant_turns=${fmt(S.turnsSub)}  user_prompt_turns=${fmt(promptTurnsTotal)}`);

  say('');
  say('=== (2) PER-TURN TOKENS (all turns, main+sub, deduped by message id) ===');
  const nT = turnsIn.length;
  const totalIn = sumIn + sumCR + sumCC;
  say(`turns=${fmt(nT)}`);
  say(`input_tokens(uncached new)  mean=${fmt(mean(turnsIn))}  p50=${fmt(pct(turnsIn, .5))}  p95=${fmt(pct(turnsIn, .95))}  total=${fmt(sumIn)}`);
  say(`cache_read                  mean=${fmt(mean(turnsCR))}  p50=${fmt(pct(turnsCR, .5))}  p95=${fmt(pct(turnsCR, .95))}  total=${fmt(sumCR)}`);
  say(`cache_creation              mean=${fmt(mean(turnsCC))}  p50=${fmt(pct(turnsCC, .5))}  p95=${fmt(pct(turnsCC, .95))}  total=${fmt(sumCC)}`);
  say(`TOTAL context per turn      mean=${fmt(mean(turnsIn.map((v, i) => v + turnsCR[i] + turnsCC[i])))}  p50=${fmt(pct(turnsIn.map((v, i) => v + turnsCR[i] + turnsCC[i]), .5))}`);
  say(`output                      mean=${fmt(mean(turnsOut))}  p50=${fmt(pct(turnsOut, .5))}  total=${fmt(sumOut)}`);
  say(`thinking_tokens             mean=${fmt(mean(turnsThink))}  total=${fmt(sumThink)}  share_of_output=${(100 * sumThink / (sumOut || 1)).toFixed(1)}%`);
  say(`cache hit ratio = cache_read/(all input) = ${(100 * sumCR / (totalIn || 1)).toFixed(1)}%   cache_creation share=${(100 * sumCC / (totalIn || 1)).toFixed(1)}%   fresh share=${(100 * sumIn / (totalIn || 1)).toFixed(1)}%`);
  say(`GRAND TOTAL input-side tokens=${fmt(totalIn)}   output=${fmt(sumOut)}`);

  say('');
  say('=== (3) FIRST ASSISTANT TURN INPUT (fixed context), main-loop sessions ===');
  say(`clean-start sessions n=${firstTurnClean.length}  mean=${fmt(mean(firstTurnClean))}  p50=${fmt(pct(firstTurnClean, .5))}  p95=${fmt(pct(firstTurnClean, .95))}  max=${fmt(Math.max(0, ...firstTurnClean))}`);
  say(`command/skill-start sessions n=${firstTurnCommand.length}  mean=${fmt(mean(firstTurnCommand))}  p50=${fmt(pct(firstTurnCommand, .5))}  max=${fmt(Math.max(0, ...firstTurnCommand))}`);

  say('');
  say('=== (4) TOOL_RESULT BYTES BY TOOL (from message.content tool_result blocks) ===');
  const trRows = [...toolResBytes.entries()].map(([k, v]) => ({ k, n: v.n, sum: v.sum, mean: v.sum / v.n, p95: pct(v.vals, .95), p50: pct(v.vals, .5), max: Math.max(...v.vals) }))
    .sort((a, b) => b.sum - a.sum);
  const trTotal = trRows.reduce((a, b) => a + b.sum, 0);
  say(`TOTAL tool_result bytes=${fmt(trTotal)} (~${fmt(trTotal / 4)} tokens) across ${fmt(trRows.reduce((a, b) => a + b.n, 0))} results`);
  say('tool                              count      total_bytes     mean    p50      p95      max');
  for (const r of trRows.slice(0, 15)) {
    say(`${r.k.padEnd(32)} ${String(r.n).padStart(6)} ${fmt(r.sum).padStart(14)} ${fmt(r.mean).padStart(8)} ${fmt(r.p50).padStart(8)} ${fmt(r.p95).padStart(8)} ${fmt(r.max).padStart(9)}`);
  }

  say('');
  say('=== (5) TOOL_USE COUNTS ===');
  const tuRows = [...toolUseCount.entries()].sort((a, b) => b[1] - a[1]);
  const tuTotal = tuRows.reduce((a, b) => a + b[1], 0);
  say(`total tool calls=${fmt(tuTotal)}`);
  for (const [k, v] of tuRows.slice(0, 20)) say(`  ${k.padEnd(40)} ${String(v).padStart(7)}`);
  say(`mcp__ tool calls=${fmt(mcpCalls)}  distinct mcp servers actually called=${mcpServersCalled.size} [${[...mcpServersCalled].join(', ')}]`);

  say('');
  say('=== (6) INJECTED TEXT (hook attachments + system reminders) ===');
  const hkRows = [...hookGroups.values()].sort((a, b) => b.bytes - a.bytes);
  const hkTotal = hkRows.reduce((a, b) => a + b.bytes, 0);
  const hkCount = hkRows.reduce((a, b) => a + b.count, 0);
  say(`hook attachment text: total_bytes=${fmt(hkTotal)} (~${fmt(hkTotal / 4)} tokens) across ${fmt(hkCount)} injections`);
  const byEvent = new Map();
  for (const r of hkRows) { const e = byEvent.get(r.event) || { bytes: 0, count: 0 }; e.bytes += r.bytes; e.count += r.count; byEvent.set(r.event, e); }
  for (const [k, v] of [...byEvent.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) say(`  event ${String(k).padEnd(18)} bytes=${fmt(v.bytes).padStart(10)} n=${String(v.count).padStart(6)} mean=${fmt(v.bytes / v.count)}`);
  say('top hook groups by total bytes:');
  for (const r of hkRows.slice(0, 18)) say(`  ${fmt(r.bytes).padStart(9)} n=${String(r.count).padStart(5)} mean=${String(Math.round(r.bytes / r.count)).padStart(5)} [${r.event}] ${r.hookName} :: ${r.sample}`);
  const srRows = [...sysReminders.values()].sort((a, b) => b.bytes - a.bytes);
  const srTotal = srRows.reduce((a, b) => a + b.bytes, 0);
  say(`system-reminder / inline injected: total_bytes=${fmt(srTotal)} (~${fmt(srTotal / 4)} tokens) across ${fmt(srRows.reduce((a, b) => a + b.count, 0))}`);
  for (const r of srRows.slice(0, 12)) say(`  ${fmt(r.bytes).padStart(9)} n=${String(r.count).padStart(5)} mean=${String(Math.round(r.bytes / r.count)).padStart(5)} :: ${r.sample}`);
  say(`injected bytes per user prompt-turn = ${fmt((hkTotal + srTotal) / (promptTurnsTotal || 1))} bytes (~${fmt((hkTotal + srTotal) / 4 / (promptTurnsTotal || 1))} tokens)`);

  say('');
  say('=== (7) SUBAGENT SPAWNS ===');
  for (const [k, v] of [...spawnByModel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    say(`  ${k.padEnd(26)} spawns=${String(v.count).padStart(4)}  first_turn_ctx mean=${fmt(mean(v.firstIn))} p50=${fmt(pct(v.firstIn, .5))} min=${fmt(Math.min(...v.firstIn))} max=${fmt(Math.max(...v.firstIn))}  total_tokens=${fmt(v.total)}`);
  }
  const spawnTot = [...spawnByModel.values()].reduce((a, b) => a + b.total, 0);
  const spawnN = [...spawnByModel.values()].reduce((a, b) => a + b.count, 0);
  say(`  ALL: spawns=${spawnN} total_tokens=${fmt(spawnTot)} (${(100 * spawnTot / (totalIn + sumOut || 1)).toFixed(1)}% of all tokens)`);

  say('');
  say('=== (8) FIXED CONTEXT vs RUNNING COST, per main session (top 15 by total) ===');
  const ps = [...perSession.entries()].sort((a, b) => b[1].total - a[1].total);
  say('session                              turns  first_turn  toolres_tok  hook_bytes  cache_creation  total_ctx');
  for (const [sid, v] of ps.slice(0, 15)) {
    say(`${sid.slice(0, 8)} ${v.slug.slice(0, 26).padEnd(26)} ${String(v.turns).padStart(5)} ${fmt(v.firstTurn).padStart(11)} ${fmt(v.toolResBytes / 4).padStart(12)} ${fmt(v.hookBytes).padStart(11)} ${fmt(v.cc).padStart(15)} ${fmt(v.total).padStart(10)}`);
  }
  const ftSum = ps.reduce((a, b) => a + b[1].firstTurn, 0);
  const trSumTok = ps.reduce((a, b) => a + b[1].toolResBytes / 4, 0);
  say(`RATIO across ${ps.length} main sessions: fixed-context(sum of first turns)=${fmt(ftSum)} tok  vs tool_result content=${fmt(trSumTok)} tok  vs total input-side=${fmt(totalIn)} tok`);

  say('');
  say('=== (9) CACHE-BUSTING: top turns by cache_creation after turn 1 ===');
  ccSpikes.sort((a, b) => b.cc - a.cc);
  say(`turns with cache_creation>3000 after turn 1: n=${ccSpikes.length}  their cache_creation total=${fmt(ccSpikes.reduce((a, b) => a + b.cc, 0))} (${(100 * ccSpikes.reduce((a, b) => a + b.cc, 0) / (sumCC || 1)).toFixed(1)}% of all cache_creation)`);
  for (const s of ccSpikes.slice(0, 10)) {
    say(`  ${s.session.slice(0, 8)}${s.sub ? '/' + s.sub.slice(0, 14) : ''} turn#${s.turnIdx} cc=${fmt(s.cc)} cr=${fmt(s.cr)} injected_blocks=${s.injected.length}`);
    for (const inj of s.injected) say(`      ${String(inj.bytes).padStart(6)}B ${inj.kind}: ${inj.head.slice(0, 150)}`);
  }

  const out = L.join('\n');
  fs.writeFileSync(path.join(__dirname, 'tokflow-report.txt'), out);
  console.log(out);
})();
