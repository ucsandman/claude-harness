#!/usr/bin/env node
/**
 * turn-close-probe.cjs — Opening Move step 2: the Stop hook (turn-close.cjs).
 *
 *   node engine/hooks/tests/turn-close-probe.cjs          # the real hook: every case must pass
 *   node engine/hooks/tests/turn-close-probe.cjs --stub   # a stub whose close() does nothing: every case must FAIL (L1)
 *
 * The five cases of spec section 4 Step 2 (edit then pass, edit only, test then edit, failing
 * test after the edit, a second enforce Stop in one prompt) plus the Next ledger, the transcript
 * fallback, a missing bus, the shadow/off/config modes, the skips, auto-quiet (and re-enabling
 * enforce after it), task notifications inside a human turn, a broken opening-move.cjs, background
 * and masked checks, the cwd repo's tainted row, and a replay of
 * 3 real bus files (copies; none is modified). The hook runs as a subprocess with HOME and
 * USERPROFILE pointed at a temp home, so no real state is read or written. Every case line
 * prints the bus count it ran on (L2).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STUB = process.argv.includes('--stub');
const REAL_HOME = process.env.USERPROFILE || os.homedir();
const REAL_BUS = path.join(REAL_HOME, '.claude', 'mods', 'state', 'events');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-close-probe-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.USERPROFILE = HOME; // before any in-process require, so STATE_DIR points at the temp home
process.env.HOME = HOME;
const STUB_FILE = path.join(TMP, 'turn-close-stub.cjs');
fs.writeFileSync(STUB_FILE, "'use strict';\nmodule.exports = { close: () => ({ out: '', info: {} }) };\nif (require.main === module) { try { require('fs').readFileSync(0); } catch (_) {} process.exit(0); }\n");
const HOOK = STUB ? STUB_FILE : path.resolve(__dirname, '..', 'turn-close.cjs');

const STATE = path.join(HOME, '.claude', 'state', 'opening-move');
const BUS = path.join(HOME, '.claude', 'mods', 'state', 'events');
const LAST = path.join(STATE, 'turn-close-last.json');
const ROWS = path.join(STATE, 'turn-close.jsonl');
const CONFIG = path.join(STATE, 'config.json');
fs.mkdirSync(BUS, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
const keyOf = (dir) => dir.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TURN_CLOSE_MODE|OPENING_MOVE|CLAUDE_CODE_ENTRYPOINT)$/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, HOME, USERPROFILE: HOME, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const rows = () => { try { return fs.readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const repoState = (dir) => readJson(path.join(STATE, 'repos', keyOf(dir) + '.json')) || {};

/** A temp repo: a directory with a .git directory is all turn-close needs to call it a repo. */
function mkRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

let seq = 0;
const T0 = Date.now() - 3600e3;
const ev = (kind, data, extra = {}) => ({ kind, source: 'probe', data, seq: ++seq, t: T0 + seq * 10, ...extra });
const prompt = (preview = 'do the thing', t) => ev('PromptSubmitted', { origin: 'composer', chars: preview.length, preview, turnId: null }, t ? { t } : {});
const edit = (p, extra) => ev('FileModified', { tool: 'Edit', path: p, tool_use_id: 'e' + seq }, extra);
const sh = (cmd, isError, { asString = false, tool = 'Bash' } = {}) => {
  const id = 'toolu_' + (seq + 1);
  return [ev('ToolRequested', { tool, tool_use_id: id, args: asString ? JSON.stringify({ command: cmd, description: 'x' }) : { command: cmd } }),
    ev('ModelStep', { index: 0 }),
    ev('ToolCompleted', { tool, tool_use_id: id, isError, ms: 5 })];
};
function writeBus(sid, events, append = false) {
  const text = events.flat().map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (append) fs.appendFileSync(path.join(BUS, sid + '.jsonl'), text); else fs.writeFileSync(path.join(BUS, sid + '.jsonl'), text);
}

let runs = 0;
function run(payload, extraEnv = {}) {
  runs++;
  try { fs.unlinkSync(LAST); } catch (_) {}
  const before = rows().length;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: cleanEnv(extraEnv), encoding: 'utf8', timeout: 20000, windowsHide: true });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (_) {}
  const last = readJson(LAST);
  return { code: r.status, out: r.stdout || '', json, last, newRows: rows().slice(before), bus: last ? last.bus : 'no turn-close-last.json' };
}
const stop = (sid, cwd, extra = {}) => ({ hook_event_name: 'Stop', session_id: sid, cwd, prompt_id: 'p-' + sid, stop_hook_active: false, last_assistant_message: 'Done.', background_tasks: [], session_crons: [], ...extra });

const results = [];
function kase(id, label, fn) {
  try {
    const detail = fn();
    results.push([id, true]);
    console.log(`  PASS (${id}) ${label}${detail ? ` [${detail}]` : ''}`);
  } catch (e) {
    results.push([id, false]);
    console.log(`  FAIL (${id}) ${label}\n         ${String(e.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);
  }
}
const mustLast = (r) => { assert.ok(r.last, 'the hook wrote no turn-close-last.json'); assert.strictEqual(r.code, 0, 'exit ' + r.code); return r.last; };

console.log(`turn-close probe${STUB ? ' --stub (every case must fail)' : ''}: hook ${HOOK}`);
try {
  const A = mkRepo('repo-a');
  const B = mkRepo('repo-b');
  const fa = path.join(A, 'src', 'parser.cjs');

  kase('a', 'edit then a passing test: no row, verdict pass, lastTest passed (JSON-string args)', () => {
    writeBus('sa', [prompt(), edit(fa), ...sh('node engine/hooks/tests/parser-probe.cjs', false, { asString: true })]);
    const r = run(stop('sa', A));
    const l = mustLast(r);
    assert.strictEqual(l.verdict, 'pass', l.line);
    assert.strictEqual(r.newRows.length, 0, JSON.stringify(r.newRows));
    assert.strictEqual(r.out, '');
    assert.deepStrictEqual([repoState(A).lastTest.isError, repoState(A).lastTest.cmd], [false, 'node engine/hooks/tests/parser-probe.cjs']);
    return `${l.bus}; rows +${r.newRows.length}`;
  });

  kase('b', 'edit only: one wouldBlock row (edits 1, verifies 0), stdout empty', () => {
    writeBus('sb', [prompt(), edit(fa)]);
    const r = run(stop('sb', A));
    const l = mustLast(r);
    assert.strictEqual(l.verdict, 'wouldBlock', l.line);
    assert.strictEqual(r.newRows.length, 1);
    const row = r.newRows[0];
    assert.deepStrictEqual([row.session, row.prompt_id, row.repo, row.edits, row.verifies, row.wouldBlock], ['sb', 'p-sb', keyOf(A), 1, 0, true]);
    assert.ok(row.ts && !row.blocked, JSON.stringify(row));
    assert.strictEqual(r.out, '');
    return `${l.bus}; rows +1`;
  });

  kase('c', 'test then edit: wouldBlock (order matters; the same events edit-first pass in case a)', () => {
    writeBus('sc', [prompt(), ...sh('npm test', false), edit(fa)]);
    const r = run(stop('sc', A));
    const l = mustLast(r);
    assert.strictEqual(l.verdict, 'wouldBlock', l.line);
    assert.strictEqual(r.newRows.length, 1);
    assert.strictEqual(r.newRows[0].verifies, 1, 'the earlier check is counted, it just does not cover the edit');
    return `${l.bus}; rows +1`;
  });

  kase('d', 'a failing test after the edit: wouldBlock, lastTest isError true', () => {
    writeBus('sd', [prompt(), edit(fa), ...sh('npm run test', true)]);
    const r = run(stop('sd', A));
    const l = mustLast(r);
    assert.strictEqual(l.verdict, 'wouldBlock', l.line);
    assert.strictEqual(r.newRows.length, 1);
    assert.strictEqual(repoState(A).lastTest.isError, true);
    return `${l.bus}; rows +1`;
  });

  kase('e', 'enforce: the first Stop blocks with the exact reason (basename only); a second Stop in the same prompt and a stop_hook_active Stop do not', () => {
    const deep = path.join(A, 'src', 'secret-dir-name', 'gate.cjs');
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    writeBus('se', [prompt(), ...sh('npm run lint', false), edit(fa), edit(deep)]);
    const first = run(stop('se', A), { TURN_CLOSE_MODE: 'enforce' });
    const second = run(stop('se', A), { TURN_CLOSE_MODE: 'enforce' });
    const active = run(stop('se', A, { prompt_id: 'p-se-2', stop_hook_active: true }), { TURN_CLOSE_MODE: 'enforce' });
    mustLast(first);
    assert.deepStrictEqual(first.json, { decision: 'block', reason: '[turn-close] You edited 2 code files after your last passing check (npm run lint). Run the narrowest test that exercises gate.cjs, read the output, then finish.' }, first.out);
    assert.ok(!first.out.includes('secret-dir-name') && !first.out.includes(A.replace(/\\/g, '\\\\')), 'only the basename may reach stdout');
    assert.strictEqual(first.newRows.length, 1);
    assert.strictEqual(first.newRows[0].blocked, true);
    assert.strictEqual(second.out, '', 'second Stop in the same prompt must not block: ' + second.out);
    assert.strictEqual(mustLast(second).verdict, 'skip: once per prompt');
    assert.strictEqual(active.out, '');
    assert.strictEqual(mustLast(active).verdict, 'skip: stop_hook_active');
    assert.strictEqual(second.newRows.length + active.newRows.length, 0);
    return `${first.bus}; blocks 1 of 3 Stops`;
  });

  kase('f', 'the Next line goes to the repo with the most edits; every touched repo gets a stop ring row; WebFetch taints; a tie goes to the cwd repo', () => {
    const fb1 = path.join(B, 'src', 'one.ts');
    const fb2 = path.join(B, 'README.md');
    writeBus('sf', [prompt(), edit(fa), edit(fb1), edit(fb2), edit(fb1), ev('ToolRequested', { tool: 'WebFetch', tool_use_id: 'w1', args: { url: 'https://example.com' } }), ...sh('npm test', false)]);
    const r = run(stop('sf', A, { last_assistant_message: 'All set.\n\nNext (me): wire the parser into the CLI' }));
    const l = mustLast(r);
    const sa = repoState(A);
    const sb = repoState(B);
    assert.ok(sb.next && sb.next.text === 'wire the parser into the CLI' && sb.next.owner === 'me' && sb.next.session === 'sf', JSON.stringify(sb.next));
    assert.ok(!sa.next || sa.next.session !== 'sf', 'the cwd repo had fewer edits and must not get the Next: ' + JSON.stringify(sa.next));
    const ra = (sa.ring || []).find((x) => x.session === 'sf');
    const rb = (sb.ring || []).find((x) => x.session === 'sf');
    assert.ok(ra && ra.source === 'stop' && ra.touched.length === 1 && ra.tainted === true, JSON.stringify(ra));
    assert.ok(rb && rb.source === 'stop' && rb.touched.length === 2 && rb.tainted === true, JSON.stringify(rb));
    const C = mkRepo('repo-c');
    const D = mkRepo('repo-d');
    writeBus('sf2', [prompt(), edit(path.join(D, 'x.cjs')), edit(path.join(C, 'y.cjs'))]);
    run(stop('sf2', C, { last_assistant_message: 'Next (me): tie case' }));
    assert.ok(repoState(C).next && repoState(C).next.text === 'tie case', 'tie must go to the cwd repo: ' + JSON.stringify(repoState(C).next));
    assert.ok(!repoState(D).next, JSON.stringify(repoState(D).next));
    return `${l.bus}; next -> repo-b (2 paths) over repo-a (1)`;
  });

  kase('g', 'an untagged Next is owner you; bold, bullet, wait and "Next (none)" forms parse; quotes are neutralised', () => {
    writeBus('sg', [prompt()]);
    const forms = [
      ['Done.\n\nNext: push the "release" branch', 'you', "push the 'release' branch"],
      ['Done.\n\n- **Next (wait 2026-12-01):** retry the sync', 'wait', 'retry the sync'],
      ['Next (me): first\n\nAll done.\nNext (none)', 'none', ''],
    ];
    const got = forms.map(([msg]) => { run(stop('sg', A, { last_assistant_message: msg })); return repoState(A).next || {}; });
    forms.forEach(([, owner, text], i) => {
      assert.strictEqual(got[i].owner, owner, `form ${i}: ${JSON.stringify(got[i])}`);
      assert.strictEqual(got[i].text, text, `form ${i}: ${JSON.stringify(got[i])}`);
    });
    assert.strictEqual(got[1].waitUntil, '2026-12-01');
    return `${forms.length} forms`;
  });

  kase('h', 'a payload without last_assistant_message falls back to the transcript tail', () => {
    const tp = path.join(TMP, 'sh.jsonl');
    fs.writeFileSync(tp, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.\n\nNext (me): run the transcript fallback check' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    ].join('\n') + '\n');
    writeBus('sh', [prompt()]);
    const p = stop('sh', B, { transcript_path: tp });
    delete p.last_assistant_message;
    const r = run(p);
    const l = mustLast(r);
    assert.strictEqual(l.text, 'transcript tail');
    assert.ok(repoState(B).next && repoState(B).next.text === 'run the transcript fallback check' && repoState(B).next.session === 'sh', JSON.stringify(repoState(B).next));
    return l.bus;
  });

  kase('i', 'a missing bus file logs "bus: 0 events (mods layer down)", writes no row, still writes the Next ledger', () => {
    const E = mkRepo('repo-e');
    const r = run(stop('si-no-bus', E, { last_assistant_message: 'Next (me): bring the mods layer back' }));
    const l = mustLast(r);
    assert.strictEqual(l.bus, 'bus: 0 events (mods layer down)');
    assert.strictEqual(l.verdict, 'skip: bus: 0 events (mods layer down)');
    assert.strictEqual(r.newRows.length, 0);
    assert.strictEqual(r.out, '');
    assert.ok(repoState(E).next && repoState(E).next.text === 'bring the mods layer back', JSON.stringify(repoState(E)));
    return l.bus;
  });

  kase('j', 'shadow mode prints nothing: default (no env, no config) and env shadow over config enforce; config enforce alone blocks', () => {
    writeBus('sj', [prompt(), edit(fa)]);
    const dflt = run(stop('sj', A, { prompt_id: 'pj1' }));
    fs.writeFileSync(CONFIG, JSON.stringify({ verifyGate: 'enforce' }));
    writeBus('sj', [prompt(), edit(fa)], true); // each Stop gets its own human prompt: once-per-prompt keys on the bus prompt
    const envShadow = run(stop('sj', A, { prompt_id: 'pj2' }), { TURN_CLOSE_MODE: 'shadow' });
    writeBus('sj', [prompt(), edit(fa)], true);
    const cfgEnforce = run(stop('sj', A, { prompt_id: 'pj3' }));
    fs.unlinkSync(CONFIG);
    assert.ok(mustLast(dflt).mode === 'shadow (default)' && dflt.out === '' && dflt.newRows.length === 1 && dflt.newRows[0].wouldBlock === true, JSON.stringify(dflt.last));
    assert.ok(mustLast(envShadow).mode === 'shadow (env TURN_CLOSE_MODE)' && envShadow.out === '' && envShadow.newRows.length === 1, JSON.stringify(envShadow.last));
    assert.ok(mustLast(cfgEnforce).mode === 'enforce (config.json)' && cfgEnforce.json && cfgEnforce.json.decision === 'block', cfgEnforce.out);
    return `${dflt.bus}; 2 silent wouldBlock rows, 1 block`;
  });

  kase('k', 'off mode prints nothing and writes no verify row, but still writes the Next ledger', () => {
    writeBus('sk', [prompt(), edit(fa)]);
    const r = run(stop('sk', A, { last_assistant_message: 'Next (me): off mode keeps the ledger' }), { TURN_CLOSE_MODE: 'off' });
    const l = mustLast(r);
    assert.strictEqual(l.verdict, 'off');
    assert.strictEqual(r.out, '');
    assert.strictEqual(r.newRows.length, 0);
    assert.ok(repoState(A).next && repoState(A).next.text === 'off mode keeps the ledger', JSON.stringify(repoState(A).next));
    return `${l.bus}; rows +0`;
  });

  kase('l', 'skips: a running background subagent, a running workflow in background_tasks, no code edits (a .md only), a non-cli entrypoint', () => {
    writeBus('sl1', [prompt(), ev('SubagentStarted', { childAgentId: 'bg1', type: 'x', background: true, denied: null }), edit(fa)]);
    const bg = run(stop('sl1', A));
    writeBus('sl2', [prompt(), edit(fa)]);
    const wf = run(stop('sl2', A, { background_tasks: [{ id: 'w', type: 'workflow', status: 'running', description: 'x' }] }));
    writeBus('sl3', [prompt(), edit(path.join(A, 'notes.md'))]);
    const md = run(stop('sl3', A));
    const sdk = run(stop('sl2', A, { prompt_id: 'p-sdk' }), { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    assert.strictEqual(mustLast(bg).verdict, 'skip: background work running (1)');
    assert.strictEqual(mustLast(wf).verdict, 'skip: background work running (1)');
    assert.strictEqual(mustLast(md).verdict, 'skip: no code edits');
    assert.ok(sdk.out === '' && sdk.last === null && sdk.newRows.length === 0, 'sdk-cli must do nothing');
    assert.strictEqual(bg.newRows.length + wf.newRows.length + md.newRows.length, 0);
    return `${bg.bus}; 4 skips, rows +0`;
  });

  kase('m', 'auto-quiet: 2 refused blocks demote config to shadow once; enforce re-enabled through config blocks again; an env enforce is never demoted', () => {
    const ledger = () => { try { return fs.readFileSync(path.join(STATE, 'ledger.jsonl'), 'utf8'); } catch (_) { return ''; } };
    const demotions = () => (ledger().match(/"outcome":"auto-demoted"/g) || []).length;
    fs.writeFileSync(CONFIG, JSON.stringify({ verifyGate: 'enforce' }));
    writeBus('sm', [prompt('build it'), edit(fa)]);
    const b1 = run(stop('sm', A, { prompt_id: 'pm1' }));
    writeBus('sm', [prompt('stop, leave it as is', Date.now() + 1000), edit(fa)], true);
    const b2 = run(stop('sm', A, { prompt_id: 'pm2' }));
    writeBus('sm', [prompt('no', Date.now() + 1000), edit(fa)], true);
    const b3 = run(stop('sm', A, { prompt_id: 'pm3' }));
    const cfg = readJson(CONFIG) || {};
    assert.ok(b1.json && b1.json.decision === 'block' && b2.json && b2.json.decision === 'block', `b1 ${b1.out} | b2 ${b2.out}`);
    assert.strictEqual(b3.out, '', 'after the demotion the third Stop must not block: ' + b3.out);
    assert.strictEqual(cfg.verifyGate, 'shadow');
    assert.ok(/"kind":"verify-gate","hash":null,"outcome":"auto-demoted"/.test(ledger()), ledger().slice(-300));
    assert.ok(b3.newRows.some((x) => x.autoDemoted === true && x.refused === 2), JSON.stringify(b3.newRows));
    // Wes turns enforce back on (the Today toggle writes config): the blocks judged before the demotion no longer count
    fs.writeFileSync(CONFIG, JSON.stringify({ verifyGate: 'enforce' }));
    writeBus('sm2', [prompt('add the flag'), edit(fa)]);
    const b4 = run(stop('sm2', A, { prompt_id: 'pm4' }));
    assert.ok(b4.json && b4.json.decision === 'block', 're-enabled enforce must block on the next Stop: ' + JSON.stringify(b4.last && b4.last.mode) + ' ' + b4.out);
    assert.strictEqual((readJson(CONFIG) || {}).verifyGate, 'enforce', 'the re-enabled config must not be re-demoted');
    fs.unlinkSync(CONFIG);
    // TURN_CLOSE_MODE=enforce: two refused blocks, then a third Stop still blocks, writes no demotion and no config
    const d0 = demotions();
    const envE = { TURN_CLOSE_MODE: 'enforce' };
    writeBus('sm3', [prompt('build it'), edit(fa)]);
    const e1 = run(stop('sm3', A, { prompt_id: 'pe1' }), envE);
    writeBus('sm3', [prompt('stop', Date.now() + 1000), edit(fa)], true);
    const e2 = run(stop('sm3', A, { prompt_id: 'pe2' }), envE);
    writeBus('sm3', [prompt('no', Date.now() + 1000), edit(fa)], true);
    const e3 = run(stop('sm3', A, { prompt_id: 'pe3' }), envE);
    assert.ok([e1, e2, e3].every((x) => x.json && x.json.decision === 'block'), 'env enforce must block all 3: ' + [e1, e2, e3].map((x) => x.out || x.last && x.last.verdict).join(' | '));
    assert.strictEqual(demotions(), d0, 'env enforce must not log auto-demoted rows');
    assert.ok(!fs.existsSync(CONFIG), 'env enforce must not write config.json');
    assert.ok(![e1, e2, e3].some((x) => x.newRows.some((r) => r.autoDemoted)), 'no autoDemoted row under env enforce');
    return `${b3.bus}; 2 of 2 blocks refused, 1 demotion, re-enabled block, env enforce 3 of 3 blocks and +${demotions() - d0} demotions`;
  });

  kase('o', 'a task notification stays inside the human turn: its edits are checked after it, once per human prompt, and the 512 KB tail is not enough when it holds only a notification', () => {
    const note = (t) => ev('PromptSubmitted', { origin: 'task-notification', chars: 120, preview: '<task-notification>', turnId: null }, t ? { t } : {});
    const wfRunning = { background_tasks: [{ id: 'w', type: 'workflow', status: 'running', description: 'x' }] };
    // shadow: the Stop while the workflow runs skips; the Stop after its notification still sees the edit
    writeBus('so', [prompt('fix it'), edit(fa)]);
    const s1 = run(stop('so', A, { prompt_id: 'po1', ...wfRunning }));
    writeBus('so', [note()], true);
    const s2 = run(stop('so', A, { prompt_id: 'po-notify' }));
    assert.strictEqual(mustLast(s1).verdict, 'skip: background work running (1)');
    assert.ok(mustLast(s2).verdict === 'wouldBlock' && s2.last.edits === 1, 'the edit before the notification must still be checked: ' + s2.last.line);
    // enforce: one block in the human prompt, none in a notification turn with another prompt_id, pass once checked
    writeBus('so2', [prompt('fix it'), edit(fa)]);
    const x1 = run(stop('so2', A, { prompt_id: 'pq1' }), { TURN_CLOSE_MODE: 'enforce' });
    writeBus('so2', [note()], true);
    const x2 = run(stop('so2', A, { prompt_id: 'pq-notify' }), { TURN_CLOSE_MODE: 'enforce' });
    writeBus('so2', [note(), ...sh('npm test', false)], true);
    const x3 = run(stop('so2', A, { prompt_id: 'pq-notify-2' }), { TURN_CLOSE_MODE: 'enforce' });
    assert.ok(x1.json && x1.json.decision === 'block', 'first Stop blocks: ' + x1.out);
    assert.strictEqual(x2.out, '', 'a notification turn inside the same human prompt must not block again: ' + x2.out);
    assert.strictEqual(mustLast(x2).verdict, 'skip: once per prompt');
    assert.strictEqual(mustLast(x3).verdict, 'pass', x3.last.line);
    // a 600 KB bus whose tail holds only a notification: the hook must read the whole file to find the human prompt
    const pad = [];
    let bytes = 0;
    const big = [prompt('fix it'), edit(fa)];
    while (bytes < 600 * 1024) { const e = ev('ModelStep', { index: seq, usage: { input_tokens: 1, output_tokens: 2 }, pad: 'x'.repeat(400) }); bytes += JSON.stringify(e).length + 1; pad.push(e); }
    writeBus('so3', [...big, ...pad, note()]);
    const y = run(stop('so3', A, { prompt_id: 'pr1' }));
    assert.ok(/whole file, no human prompt in the tail/.test(mustLast(y).bus) && y.last.verdict === 'wouldBlock' && y.last.edits === 1, y.last.line);
    return `${y.bus}; ${s2.bus}; 1 block in 3 enforce Stops`;
  });

  kase('p', 'a broken opening-move.cjs beside the hook: exit 0, 0 bytes on stdout and stderr, nothing written; a sound one beside the same copy runs', () => {
    const bad = path.join(TMP, 'om-broken');
    const good = path.join(TMP, 'om-sound');
    for (const d of [bad, good]) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(HOOK, path.join(d, 'turn-close.cjs')); }
    fs.writeFileSync(path.join(bad, 'opening-move.cjs'), 'module.exports = {;');
    for (const f of ['opening-move.cjs', 'wakeup-guard.cjs']) fs.copyFileSync(path.resolve(__dirname, '..', f), path.join(good, f));
    writeBus('sp', [prompt(), edit(fa)]);
    const input = JSON.stringify(stop('sp', A, { last_assistant_message: 'Next (me): the loader case' }));
    const spawn = (dir) => { try { fs.unlinkSync(LAST); } catch (_) {} runs++; return spawnSync(process.execPath, [path.join(dir, 'turn-close.cjs')], { input, env: cleanEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true }); };
    const b = spawn(bad);
    const bLast = readJson(LAST);
    assert.deepStrictEqual([b.status, (b.stdout || '').length, (b.stderr || '').length], [0, 0, 0], `broken loader: exit ${b.status}, stderr ${JSON.stringify(String(b.stderr || '').slice(0, 160))}`);
    assert.strictEqual(bLast, null, 'a broken loader must write nothing: ' + JSON.stringify(bLast));
    const g = spawn(good);
    const gLast = readJson(LAST);
    assert.ok(g.status === 0 && gLast && gLast.verdict === 'wouldBlock', 'positive control (sound loader): ' + JSON.stringify(gLast));
    return `broken: exit ${b.status}, ${(b.stdout || '').length + (b.stderr || '').length} bytes out; sound: ${gLast.bus}`;
  });

  // a Bash check with its own completion preview: the bus shape of a real run_in_background call (2026-11-09)
  const shBg = (args, preview, isError = false) => {
    const id = 'toolu_' + (seq + 1);
    return [ev('ToolRequested', { tool: 'Bash', tool_use_id: id, args }), ev('ToolCompleted', { tool: 'Bash', tool_use_id: id, isError, ms: 5, preview })];
  };
  kase('q', 'a check run in the background never passes: run_in_background in object or string args, or a "Command running in background" completion', () => {
    const BG = 'Command running in background with ID: bq1. Output is being written to: x.output';
    const variants = [
      ['object args', { command: 'npm test', run_in_background: true }, BG],
      ['string args', JSON.stringify({ command: 'npm test', description: 'x', run_in_background: true }), '> test'],
      ['completion only', { command: 'npm test' }, BG],
    ];
    const got = variants.map(([label, args, preview], i) => { writeBus('sq' + i, [prompt(), edit(fa), ...shBg(args, preview)]); return [label, mustLast(run(stop('sq' + i, A)))]; });
    writeBus('sq-fg', [prompt(), edit(fa), ...shBg({ command: 'npm test', run_in_background: false }, '> test\nok')]);
    const fg = mustLast(run(stop('sq-fg', A)));
    for (const [label, l] of got) assert.ok(l.verdict === 'wouldBlock' && l.lastTest === 'none this turn' && l.verifies === 1, `${label}: ${l.line}`);
    assert.ok(fg.verdict === 'pass' && fg.lastTest === 'passed', 'positive control (foreground): ' + fg.line);
    return `${fg.bus}; ${got.length} background runs wouldBlock, foreground pass`;
  });

  kase('r', 'a masked check (a pipe, ;, || or a lone & after it, no pipefail) never passes and is not lastTest; && chains and 2>&1 still pass', () => {
    const masked = ['npm test | tail -5', 'npm test; echo done', 'npm test || true', 'npm test &', 'node engine/hooks/tests/x-probe.cjs > log.txt 2>&1; echo EXIT=$?'];
    const clear = ['npm test && npm run lint', 'npm test 2>&1', 'cd src && npm test', 'set -o pipefail; npm test | tail -5', 'npm test; if ($LASTEXITCODE) { exit 1 }'];
    const judge = (cmd, i, k) => { writeBus(`sr-${k}${i}`, [prompt(), edit(fa), ...sh(cmd, false)]); return [cmd, mustLast(run(stop(`sr-${k}${i}`, A)))]; };
    const m = masked.map((c, i) => judge(c, i, 'm'));
    const c = clear.map((x, i) => judge(x, i, 'c'));
    const wrongM = m.filter(([, l]) => !(l.verdict === 'wouldBlock' && l.lastTest === 'none this turn')).map(([cmd, l]) => `${cmd} -> ${l.verdict}, lastTest ${l.lastTest}`);
    const wrongC = c.filter(([, l]) => !(l.verdict === 'pass' && l.lastTest === 'passed')).map(([cmd, l]) => `${cmd} -> ${l.verdict}, lastTest ${l.lastTest}`);
    assert.ok(!wrongM.length && !wrongC.length, `masked judged as a result: ${wrongM.join(' | ')}; clear judged as masked: ${wrongC.join(' | ')}`);
    return `${m[0][1].bus}; ${masked.length} masked wouldBlock, ${clear.length} clear pass`;
  });

  kase('s', 'the cwd repo ring row gets tainted even when every edit landed in another repo, and keeps its own touched list', () => {
    const C = mkRepo('repo-s-cwd');
    const D = mkRepo('repo-s-edit');
    fs.mkdirSync(path.join(STATE, 'repos'), { recursive: true });
    // the prompt half (opening-move main) already wrote this session's row in the cwd repo
    fs.writeFileSync(path.join(STATE, 'repos', keyOf(C) + '.json'), JSON.stringify({ repo: C, ring: [{ session: 'ss', transcript_path: 'ss.jsonl', cwd: C, ts: new Date().toISOString(), source: 'prompt', touched: ['src/old.cjs'] }] }));
    writeBus('ss', [prompt(), ev('ToolRequested', { tool: 'WebFetch', tool_use_id: 'w2', args: { url: 'https://example.com' } }), edit(path.join(D, 'src', 'x.cjs'))]);
    const l = mustLast(run(stop('ss', C, { last_assistant_message: 'Next (me): the cwd taint case' })));
    const rc = (repoState(C).ring || []).find((x) => x.session === 'ss');
    const rd = (repoState(D).ring || []).find((x) => x.session === 'ss');
    assert.ok(rd && rd.tainted === true && rd.touched.length === 1, 'edited repo row: ' + JSON.stringify(rd));
    assert.ok(rc && rc.tainted === true, 'the cwd repo row must carry tainted: ' + JSON.stringify(rc));
    assert.deepStrictEqual(rc.touched, ['src/old.cjs'], 'the cwd row keeps its own touched list');
    assert.ok(repoState(D).next && repoState(D).next.text === 'the cwd taint case' && !repoState(C).next, 'the Next still goes to the edited repo');
    return `${l.bus}; cwd row tainted, next -> repo-s-edit`;
  });

  kase('t', 'finals.jsonl: a human-prompt Stop with a Next line writes {hasNext: true, owner}, one without writes hasNext: false; a Stop after a task notification and an enforce block write none', () => {
    const FINALS = path.join(STATE, 'finals.jsonl');
    const finals = () => { try { return fs.readFileSync(FINALS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
    const T = mkRepo('repo-t');
    const before = finals().length;
    writeBus('st1', [prompt('fix the parser')]);
    run(stop('st1', T, { last_assistant_message: 'Done.\n\nNext (me): run the parser suite' }));
    writeBus('st2', [prompt('what changed?')]);
    run(stop('st2', T, { last_assistant_message: 'Two files changed.' }));
    writeBus('st3', [prompt('start the workflow'), ev('PromptSubmitted', { origin: 'task-notification', chars: 120, preview: '<task-notification>', turnId: null })]);
    run(stop('st3', T, { last_assistant_message: 'Next (me): read the verdicts' }));
    writeBus('st4', [prompt('build it'), edit(path.join(T, 'src', 'b.cjs'))]);
    const blocked = run(stop('st4', T, { last_assistant_message: 'Built.\n\nNext (me): test it' }), { TURN_CLOSE_MODE: 'enforce' });
    const rows = finals().slice(before);
    assert.ok(blocked.json && blocked.json.decision === 'block', 'the enforce Stop must block: ' + blocked.out);
    assert.strictEqual(rows.length, 2, 'two final messages; none for the notification or the block: ' + JSON.stringify(rows));
    assert.deepStrictEqual(rows.map((r) => [r.session, r.repo, r.hasNext, r.owner]), [['st1', keyOf(T), true, 'me'], ['st2', keyOf(T), false, null]]);
    assert.ok(rows.every((r) => Number.isFinite(Date.parse(r.ts))), 'every row carries ts: ' + JSON.stringify(rows));
    return `${rows.length} finals rows from 4 Stops`;
  });

  // Real bus files: copies of three. One exceeds 512 KB (the tail path); two end in a turn whose
  // main thread edited a code file that still exists inside a git repo (an oracle written here,
  // independent of the hook), so the replay must reach a verdict, not "no code edits".
  const CODE = /\.(cjs|js|mjs|ts|tsx|py|ps1|sh|go|rs)$/i;
  const inRepo = (p) => { let d = path.dirname(p); for (let i = 0; i < 64; i++) { if (fs.existsSync(path.join(d, '.git'))) return true; const u = path.dirname(d); if (u === d) return false; d = u; } return false; };
  // A human prompt line: main thread, origin composer or sdk (or none). Notifications do not open a turn.
  const humanLine = (l) => { if (!l.startsWith('{"kind":"PromptSubmitted"') || l.includes('"agentId"')) return false; const o = /"origin":"([^"]*)"/.exec(l); return !o || o[1] === 'composer' || o[1] === 'sdk'; };
  function lastTurnEdits(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (humanLine(lines[i])) { start = i; break; }
    const paths = new Set();
    for (const l of lines.slice(start + 1)) {
      if (!l.startsWith('{"kind":"FileModified"') || l.includes('"agentId"')) continue;
      try { const p = JSON.parse(l).data.path; if (CODE.test(p) && fs.existsSync(p) && inRepo(p)) paths.add(p.toLowerCase()); } catch (_) {}
    }
    return paths.size;
  }
  let real = [];
  try {
    const all = fs.readdirSync(REAL_BUS).filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f)).map((f) => ({ f, size: fs.statSync(path.join(REAL_BUS, f)).size })).filter((x) => x.size <= 8 * 1024 * 1024).sort((a, b) => b.size - a.size);
    const big = all.find((x) => x.size > 512 * 1024);
    const edited = [];
    for (const x of all.filter((y) => y !== big && y.size < 2 * 1024 * 1024 && y.size > 4 * 1024)) {
      const n = lastTurnEdits(path.join(REAL_BUS, x.f));
      if (n) edited.push({ ...x, oracle: n });
      if (edited.length === 2) break;
    }
    real = [big, ...edited].filter(Boolean);
  } catch (_) {}
  kase('n', `replay ${real.length} of 3 real bus files (copies): exit 0, silent in shadow, scanned count matches an independent line count, an edited last turn reaches a verdict`, () => {
    assert.strictEqual(real.length, 3, `only ${real.length} usable real bus files on this machine (${REAL_BUS})`);
    const bits = [];
    for (const { f, size, oracle } of real) {
      const sid = f.replace(/\.jsonl$/, '');
      fs.copyFileSync(path.join(REAL_BUS, f), path.join(BUS, f));
      const buf = fs.readFileSync(path.join(BUS, f));
      let text = buf.toString('utf8');
      if (size > 512 * 1024) {
        const t = buf.subarray(size - 512 * 1024).toString('utf8');
        const tailText = t.slice(t.indexOf('\n') + 1);
        if (tailText.split('\n').some(humanLine)) text = tailText;
      }
      const expected = text.split('\n').filter((l) => l && l !== '\r').length;
      const r = run(stop(sid, A, { prompt_id: 'real-' + sid.slice(0, 8) }));
      const l = mustLast(r);
      assert.strictEqual(r.out, '', 'shadow must print nothing');
      const m = /^bus: (\d+) events scanned \((512 KB tail|whole file)/.exec(l.bus || '');
      assert.ok(m, 'bus line: ' + l.bus);
      assert.strictEqual(Number(m[1]), expected, `${f}: scanned ${m[1]}, independent count ${expected}`);
      assert.ok(/^(pass|wouldBlock|skip: .+)$/.test(l.verdict), l.verdict);
      if (oracle) {
        assert.ok(l.edits >= oracle, `${f}: the hook counted ${l.edits} code files, the oracle ${oracle} main-thread ones`);
        assert.ok(/^(pass|wouldBlock|skip: background work running \(\d+\))$/.test(l.verdict), `${f}: an edited turn must reach a verdict, got ${l.verdict}`);
      }
      bits.push(`${(size / 1024).toFixed(0)} KB: ${l.bus}, ${l.edits || 0} edits, ${l.verdict}`);
    }
    return bits.join(' | ');
  });
} finally {
  // timing, in process, on a synthetic 600 KB bus (the 512 KB tail path) before the temp dir goes
  if (!STUB && results.every(([, ok]) => ok)) {
    try {
      const tc = require(HOOK);
      const sid = 'timing';
      const fill = (kb) => {
        const out = [];
        let bytes = 0;
        while (bytes < kb * 1024) {
          const batch = [ev('ModelStep', { index: seq, usage: { input_tokens: 1, output_tokens: 2 } }), ev('PermissionRequested', { tool: 'Bash', input: { command: 'git status' } }),
            ...sh('git status --short', false), edit(path.join(TMP, 'repo-a', 'src', 'f' + (seq % 7) + '.cjs'))];
          for (const e of batch) bytes += JSON.stringify(e).length + 1;
          out.push(...batch);
        }
        return out;
      };
      seq = 0;
      writeBus(sid, [...fill(100), prompt(), ...fill(500)]); // 600 KB: the prompt sits inside the 512 KB tail
      const ms = [];
      for (let i = 0; i < 7; i++) ms.push(tc.close(stop(sid, path.join(TMP, 'repo-a'), { prompt_id: 'pt' + i }), { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', TURN_CLOSE_MODE: 'shadow' } }).info);
      const sorted = ms.map((x) => x.ms).sort((a, b) => a - b);
      const med = sorted[3];
      console.log(`\ntiming: ${ms[0].bus}, ${ms[0].window} in this turn; close() median ${med} ms, min ${sorted[0]}, max ${sorted[6]} over 7 runs (excl. node start); budget 50 ms: ${med < 50 ? 'within' : 'OVER'}`);
    } catch (e) { console.log('timing: not measured (' + String(e.message).slice(0, 120) + ')'); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

const passed = results.filter(([, ok]) => ok).length;
const failed = results.length - passed;
console.log(`\n${results.length} cases ran: ${passed} passed, ${failed} failed (${runs} hook runs)`);
if (STUB) {
  console.log(failed === results.length ? `stub: ${failed} of ${results.length} cases failed as expected, the probe bites` : `stub: only ${failed} of ${results.length} cases failed; a case that passes against the stub proves nothing`);
  process.exit(failed === results.length ? 0 : 1);
}
process.exit(failed ? 1 : 0);
