#!/usr/bin/env node
/**
 * reg-ladder.cjs — the distillation ladder state machine and every writer routed
 * through it.
 *
 * Covers:
 *   1. Table invariants of engine/distill/ladder.cjs (states, edges, terminal
 *      set, reachability, stored-literal parity, labels).
 *   2. One case per illegal pair (refused) and one per legal edge (accepted).
 *   3. The routed writers: approveCandidate, runDistillation, updateCandidate,
 *      deleteCandidate.
 *   4. The surfaces: dashboard HTTP (409 contract, additive read fields, the
 *      injected ladder data), the distill --approve CLI (exit 2), and the
 *      dashboard markup deriving its options from allowed_next.
 *
 * Hermetic: AGNOSTIC_STORAGE and AGNOSTIC_EXAMPLES_DIR point at a temp dir
 * before anything is required, and every rules file is a temp copy. The one
 * route that defaults to the real core/rules/global-rules.md (HTTP approve) is
 * snapshotted and restored, and must come back byte-identical. The shape check
 * over the real ledger is read-only.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-ladder-'));
const TMP_STORAGE = path.join(TMP, 'storage');
const TMP_EXAMPLES = path.join(TMP, 'examples');
fs.mkdirSync(TMP_STORAGE, { recursive: true });

// Redirect engine storage before anything is required.
process.env.AGNOSTIC_STORAGE = TMP_STORAGE;
process.env.AGNOSTIC_EXAMPLES_DIR = TMP_EXAMPLES;

const ladder = require('../distill/ladder.cjs');
const {
  LADDER_STATES, TIER_VALUES, STATUS_VALUES, STATE_TIER, IMPORT_ONLY_STATES, GATED_STATES,
  RULE_GATE_DAYS, LADDER_TRANSITIONS, TERMINAL_STATES, LADDER_STATE_LABELS, IllegalTransitionError,
  stateOf, stateForTier, meetsRuleGate, canTransition, assertTransition, nextStates, allowedNext
} = ladder;
const { approveCandidate, runDistillation, hashFingerprint } = require('../distill/distill.cjs');
const { updateCandidate, deleteCandidate, getCandidate, loadDeletedIds } = require('../harvest/harvest.cjs');

const CANDIDATES_FILE = path.join(TMP_STORAGE, 'candidates.jsonl');
const CORRECTIONS_FILE = path.join(TMP_STORAGE, 'corrections.jsonl');
const DELETED_FILE = path.join(TMP_STORAGE, 'deleted-candidates.json');
const DIGEST_FILE = path.join(TMP_STORAGE, 'distill-digest.json');
const REAL_RULES_FILE = path.join(ROOT, 'core', 'rules', 'global-rules.md');
const DASHBOARD = path.join(ROOT, 'tools', 'dashboard', 'dashboard.cjs');
const DISTILL = path.join(ROOT, 'engine', 'distill', 'distill.cjs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── helpers ──────────────────────────────────────────────────────────────────

const DAYS3 = ['2026-08-01', '2026-08-02', '2026-08-03'];
const DAYS1 = ['2026-08-01'];

function writeCandidates(items) {
  fs.writeFileSync(CANDIDATES_FILE, items.map(i => JSON.stringify(i)).join('\n') + '\n', 'utf8');
}
function readCandidates() {
  if (!fs.existsSync(CANDIDATES_FILE)) return [];
  return fs.readFileSync(CANDIDATES_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function stored(id) { return readCandidates().find(c => c.id === id); }
function resetDistillInputs() {
  for (const f of [CORRECTIONS_FILE, DELETED_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
let rulesSeq = 0;
function tempRules() {
  const file = path.join(TMP, `rules-${++rulesSeq}.md`);
  fs.writeFileSync(file, '# Agreement\n\n## Learned Rules (Self-Promoted via Distillation Ladder)\n\n- **L1 (2026-08-13) — An existing rule.**\n', 'utf8');
  return file;
}
function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}
function distill() { return quiet(() => runDistillation()); }

// One stored row per live state, every one past the rule gate.
const REP = {
  observation: { tier: 0, sightingDays: DAYS3 },
  fact: { tier: 1, sightingDays: DAYS3 },
  proposed: { tier: 2, sightingDays: DAYS3 },
  promoted: { tier: 2, status: 'promoted', sightingDays: DAYS3 },
  trait: { tier: 3, sightingDays: DAYS3 },
  dropped: { tier: 0, status: 'dropped', sightingDays: DAYS3 }
};
function row(id, shape, extra = {}) {
  return { id, text: `Ladder fixture ${id}.`, firstSeen: '2026-08-01', client: 'claude', ...shape, ...extra };
}

function assertRefusal(err, from, to, allowed) {
  assert(err instanceof IllegalTransitionError, `expected IllegalTransitionError, got ${err && err.name}`);
  assert.strictEqual(err.code, 'illegal_transition');
  assert.strictEqual(err.current, from);
  assert.strictEqual(err.requested, to);
  assert.deepStrictEqual(err.allowed, allowed);
  const named = to === null ? 'an unknown state' : to;
  assert(typeof err.message === 'string' && err.message.includes(`from ${from} to ${named}`), `message: ${err.message}`);
  const json = err.toJSON();
  assert.deepStrictEqual(Object.keys(json), ['error', 'current', 'requested', 'allowed', 'message']);
  assert.strictEqual(json.error, 'illegal_transition');
}

function throwsRefusal(fn) {
  try { fn(); } catch (err) { return err; }
  throw new Error('expected a refusal, nothing was thrown');
}

// ── 1. Table invariants ──────────────────────────────────────────────────────

test('table: keys are exactly LADDER_STATES, every target is a state, no self-edges', () => {
  assert.deepStrictEqual(Object.keys(LADDER_TRANSITIONS), LADDER_STATES.slice());
  for (const [from, tos] of Object.entries(LADDER_TRANSITIONS)) {
    for (const to of tos) {
      assert(LADDER_STATES.includes(to), `${from} -> ${to} targets an unknown state`);
      assert.notStrictEqual(to, from, `${from} has a self-edge`);
    }
  }
  const edges = Object.values(LADDER_TRANSITIONS).reduce((n, t) => n + t.length, 0);
  assert.strictEqual(edges, 14, `expected 14 edges, found ${edges}`);
});

test('table: TERMINAL_STATES is derived as [tombstoned] and has no outgoing edges', () => {
  assert.deepStrictEqual(TERMINAL_STATES.slice(), ['tombstoned']);
  for (const t of TERMINAL_STATES) assert.strictEqual(LADDER_TRANSITIONS[t].length, 0);
});

test('table: every live state can be tombstoned (why delete and the bloat purge need no guard)', () => {
  for (const s of LADDER_STATES.filter(s => s !== 'tombstoned')) {
    assert(LADDER_TRANSITIONS[s].includes('tombstoned'), `${s} has no tombstoned edge`);
  }
});

test('table: reachable-from-observation plus IMPORT_ONLY_STATES is every state, disjoint', () => {
  const seen = new Set(['observation']);
  const queue = ['observation'];
  while (queue.length) {
    for (const to of LADDER_TRANSITIONS[queue.shift()]) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  }
  assert.deepStrictEqual(IMPORT_ONLY_STATES.slice(), ['trait', 'dropped']);
  for (const s of IMPORT_ONLY_STATES) assert(!seen.has(s), `${s} is both reachable and import-only`);
  assert.deepStrictEqual([...seen, ...IMPORT_ONLY_STATES].sort(), LADDER_STATES.slice().sort());
});

test('table: stored tier and status literals in distill.cjs and harvest.cjs are known values', () => {
  const tierLits = [];
  const statusLits = [];
  for (const rel of ['engine/distill/distill.cjs', 'engine/harvest/harvest.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\btier\s*(?:=|:)\s*(-?\d+)/g)) tierLits.push(Number(m[1]));
    for (const m of src.matchAll(/\bstatus:\s*'(\w+)'/g)) statusLits.push(m[1]);
    for (const m of src.matchAll(/\bconst status = [^\n]*'(\w+)';/g)) statusLits.push(m[1]);
  }
  assert(tierLits.length >= 6, `expected >= 6 tier literals, found ${tierLits.length}`);
  assert(statusLits.length >= 2, `expected >= 2 status literals, found ${statusLits.length}`);
  for (const t of tierLits) assert(TIER_VALUES.includes(t), `tier literal ${t} is not in TIER_VALUES`);
  for (const s of statusLits) assert(STATUS_VALUES.includes(s), `status literal '${s}' is not in STATUS_VALUES`);
});

test('table: stateOf is total over tier x status x promoted and never derives tombstoned (56 shapes)', () => {
  let n = 0;
  for (const tier of [...TIER_VALUES, null, undefined, NaN]) {
    for (const status of [...STATUS_VALUES, undefined]) {
      for (const promoted of [true, undefined]) {
        const s = stateOf({ tier, status, promoted });
        assert(LADDER_STATES.includes(s) && s !== 'tombstoned', `stateOf(${tier}/${status}/${promoted}) = ${s}`);
        n++;
      }
    }
  }
  assert.strictEqual(n, 56);
});

test('table: the 6 live row shapes map to the expected states', () => {
  assert.strictEqual(stateOf({ tier: 1 }), 'fact');
  assert.strictEqual(stateOf({ tier: 0, status: 'watching' }), 'observation');
  assert.strictEqual(stateOf({ tier: 2, status: 'promoted' }), 'promoted');
  assert.strictEqual(stateOf({ tier: 1, status: 'promoted' }), 'fact');
  assert.strictEqual(stateOf({ tier: 0, status: 'dropped' }), 'dropped');
  assert.strictEqual(stateOf({ tier: 1, promoted: true }), 'promoted');
});

test('table: labels cover exactly the states; STATE_TIER values are tiers; stateForTier inverts the tiers', () => {
  assert.deepStrictEqual(Object.keys(LADDER_STATE_LABELS).sort(), LADDER_STATES.slice().sort());
  for (const s of LADDER_STATES) assert(typeof LADDER_STATE_LABELS[s] === 'string' && LADDER_STATE_LABELS[s].trim(), `${s} label`);
  for (const [s, t] of Object.entries(STATE_TIER)) {
    assert(LADDER_STATES.includes(s), `STATE_TIER key ${s}`);
    assert(TIER_VALUES.includes(t), `STATE_TIER.${s} = ${t}`);
  }
  for (const t of TIER_VALUES) assert.strictEqual(STATE_TIER[stateForTier(t)], t);
  for (const bad of [7, -1, NaN, 'abc', undefined]) assert.strictEqual(stateForTier(bad), undefined);
  assert.deepStrictEqual(GATED_STATES.slice(), ['proposed', 'promoted']);
  assert.strictEqual(RULE_GATE_DAYS, 3);
  assert.strictEqual(meetsRuleGate({ sightingDays: DAYS3 }), true);
  assert.strictEqual(meetsRuleGate({ sightingDays: ['2026-08-01', '2026-08-01', '2026-08-02'] }), false, 'days must be distinct');
});

test('table: identity is a no-op success in every state; unknown targets are refused', () => {
  for (const s of LADDER_STATES) {
    assert.strictEqual(canTransition(s, s, REP[s]), true, `${s} -> ${s}`);
    assertTransition(s, s, REP[s]);
  }
  assert.strictEqual(canTransition('observation', undefined, REP.observation), false);
  assertRefusal(throwsRefusal(() => assertTransition('observation', undefined, REP.observation)), 'observation', null, allowedNext(REP.observation));
});

test('table: tombstoned -> X is refused for every X other than tombstoned', () => {
  for (const to of LADDER_STATES.filter(s => s !== 'tombstoned')) {
    assert.strictEqual(canTransition('tombstoned', to, REP.observation), false, `tombstoned -> ${to}`);
  }
  assert.deepStrictEqual(nextStates('tombstoned'), []);
});

// ── 2. Exhaustive matrix ─────────────────────────────────────────────────────

for (const s of Object.keys(REP)) {
  assert.strictEqual(stateOf(REP[s]), s, `fixture REP.${s} must derive ${s}`);
}

const illegalPairs = [];
const legalEdges = [];
for (const from of LADDER_STATES) {
  for (const to of LADDER_STATES) {
    if (from === to) continue;
    (LADDER_TRANSITIONS[from].includes(to) ? legalEdges : illegalPairs).push([from, to]);
  }
}

test(`matrix: 28 illegal pairs and 14 legal edges (found ${illegalPairs.length} / ${legalEdges.length})`, () => {
  assert.strictEqual(illegalPairs.length, 28);
  assert.strictEqual(legalEdges.length, 14);
});

for (const [from, to] of illegalPairs) {
  test(`illegal: ${from} -> ${to} is refused`, () => {
    const item = REP[from];
    assert.strictEqual(canTransition(from, to, item), false);
    const expectedAllowed = item ? allowedNext(item) : nextStates(from);
    assertRefusal(throwsRefusal(() => assertTransition(from, to, item)), from, to, expectedAllowed);
  });
}

for (const [from, to] of legalEdges) {
  test(`legal: ${from} -> ${to} is accepted${GATED_STATES.includes(to) ? ' (and refused under the 3-day gate)' : ''}`, () => {
    assert.strictEqual(canTransition(from, to, REP[from]), true);
    assertTransition(from, to, REP[from]);
    if (GATED_STATES.includes(to)) {
      const under = { ...REP[from], sightingDays: DAYS1 };
      assert.strictEqual(canTransition(from, to, under), false);
      const err = throwsRefusal(() => assertTransition(from, to, under));
      assertRefusal(err, from, to, allowedNext(under));
      assert(err.message.includes('needs 3 distinct sighting days (has 1)'), err.message);
    }
  });
}

// ── 3a. approveCandidate ─────────────────────────────────────────────────────

function approveRefused(id, shape, current) {
  const rules = tempRules();
  const before = fs.readFileSync(rules);
  writeCandidates([row(id, shape)]);
  const res = approveCandidate(id, rules);
  assert.strictEqual(res.ok, false, JSON.stringify(res));
  assert.strictEqual(res.reason, 'illegal_transition');
  assert.strictEqual(res.current, current);
  assert.strictEqual(res.requested, 'promoted');
  assert.deepStrictEqual(res.allowed, allowedNext(row(id, shape)));
  assert(res.message.includes(`from ${current} to promoted`), res.message);
  assert(fs.readFileSync(rules).equals(before), 'rules file must be byte-identical');
  assert.notStrictEqual(stored(id).promoted, true, 'candidate must not be marked promoted');
  assert.strictEqual(stored(id).tier, shape.tier, 'tier must be unchanged');
}

test('approve: observation -> promoted is refused, rules file untouched', () => approveRefused('apobs', REP.observation, 'observation'));
test('approve: fact -> promoted under the gate (1 day) is refused', () => approveRefused('apfact1', { tier: 1, sightingDays: DAYS1 }, 'fact'));
test('approve: proposed -> promoted under the gate (1 day) is refused', () => approveRefused('approp1', { tier: 2, sightingDays: DAYS1 }, 'proposed'));
test('approve: dropped -> promoted is refused', () => approveRefused('apdrop', REP.dropped, 'dropped'));
test('approve: trait -> promoted is refused', () => approveRefused('aptrait', REP.trait, 'trait'));

test('approve: proposed -> promoted (3 days) appends the L-rule', () => {
  const rules = tempRules();
  writeCandidates([row('approp', REP.proposed)]);
  const res = approveCandidate('approp', rules);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.label, 'L2');
  assert(fs.readFileSync(rules, 'utf8').includes('Ladder fixture approp.'));
  assert.strictEqual(res.state, 'promoted');
  assert.deepStrictEqual(res.allowed_next, ['tombstoned']);
  assert.strictEqual(stored('approp').promoted, true);
});

test('approve: fact -> promoted (3 days) appends the L-rule', () => {
  const rules = tempRules();
  writeCandidates([row('apfact', REP.fact)]);
  const res = approveCandidate('apfact', rules);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert(fs.readFileSync(rules, 'utf8').includes('Ladder fixture apfact.'));
});

test('approve: promoted -> promoted identity returns ok alreadyPresent and writes nothing new', () => {
  const rules = tempRules();
  writeCandidates([row('apident', REP.proposed)]);
  assert.strictEqual(approveCandidate('apident', rules).ok, true);
  const after1 = fs.readFileSync(rules);
  const res = approveCandidate('apident', rules);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.alreadyPresent, true);
  assert.strictEqual(res.state, 'promoted');
  assert(fs.readFileSync(rules).equals(after1), 'second approve must not change the rules file');
});

// ── 3b. runDistillation ──────────────────────────────────────────────────────

test('distill: a dropped 3-day row is neither proposed nor exampled', () => {
  resetDistillInputs();
  writeCandidates([row('ddrop', REP.dropped)]);
  const digest = distill();
  assert.strictEqual(stored('ddrop').tier, 0);
  assert(!digest.candidateRules.some(c => c.id === 'ddrop'), 'must not be a candidate rule');
  assert(!digest.examplesMigrated.some(e => e.item.id === 'ddrop'), 'must not be migrated to examples');
  assert(!fs.existsSync(path.join(TMP_EXAMPLES, 'ddrop.json')), 'no example fixture may be written');
});

test('distill: a dropped row with a repo is not lifted to fact', () => {
  resetDistillInputs();
  writeCandidates([row('ddroprepo', { tier: 0, status: 'dropped', sightingDays: DAYS1, repo: 'x' })]);
  const digest = distill();
  assert.strictEqual(stored('ddroprepo').tier, 0);
  assert(!digest.promotedFacts.some(c => c.id === 'ddroprepo'));
});

test('distill: a tombstoned correction never comes back (and a live one still does)', () => {
  resetDistillInputs();
  writeCandidates([row('dkeep', REP.fact)]);
  const deadText = 'A correction that was deleted from the dashboard.';
  const liveText = 'A correction that is still wanted.';
  fs.writeFileSync(CORRECTIONS_FILE, [deadText, liveText].map(c => JSON.stringify({ correction: c, client: 'claude' })).join('\n') + '\n', 'utf8');
  fs.writeFileSync(DELETED_FILE, JSON.stringify([hashFingerprint(deadText)]), 'utf8');
  distill();
  const ids = readCandidates().map(c => c.id);
  assert(!ids.includes(hashFingerprint(deadText)), 'tombstoned fingerprint must stay out of candidates.jsonl');
  assert(ids.includes(hashFingerprint(liveText)), 'the live correction must still be harvested (proves the loop ran)');
  resetDistillInputs();
});

test('distill: observation -> fact when the row names a repo', () => {
  resetDistillInputs();
  writeCandidates([row('dobsrepo', { tier: 0, sightingDays: DAYS1, repo: 'x' })]);
  const digest = distill();
  assert.strictEqual(stored('dobsrepo').tier, 1);
  assert(digest.promotedFacts.some(c => c.id === 'dobsrepo'));
});

test('distill: a 3-day observation passes the guard into the rule gate (candidate rule or example)', () => {
  resetDistillInputs();
  writeCandidates([row('dobs3', REP.observation)]);
  const digest = distill();
  const proposed = digest.candidateRules.some(c => c.id === 'dobs3');
  const exampled = digest.examplesMigrated.some(e => e.item.id === 'dobs3');
  assert(proposed || exampled, 'a 3-day observation must reach prune');
  if (proposed) assert.strictEqual(stored('dobs3').tier, 2);
});

test('distill: an already-proposed row is not re-evaluated (identity is not a proposal)', () => {
  resetDistillInputs();
  writeCandidates([row('dprop', REP.proposed)]);
  const digest = distill();
  assert(!digest.candidateRules.some(c => c.id === 'dprop'));
  assert(!digest.examplesMigrated.some(e => e.item.id === 'dprop'));
  assert.strictEqual(stored('dprop').tier, 2);
});

// ── 3c. updateCandidate ──────────────────────────────────────────────────────

function updateRefused(id, shape, tier, from, to) {
  writeCandidates([row(id, shape)]);
  if (fs.existsSync(DIGEST_FILE)) fs.unlinkSync(DIGEST_FILE);
  const before = fs.readFileSync(CANDIDATES_FILE);
  const err = throwsRefusal(() => updateCandidate(id, { tier, text: 'An edit riding along with a refused tier.' }));
  assertRefusal(err, from, to, allowedNext(row(id, shape)));
  assert(fs.readFileSync(CANDIDATES_FILE).equals(before), 'candidates.jsonl must be byte-identical');
  assert(!fs.existsSync(DIGEST_FILE), 'a refused update must write nothing');
}

test('update: promoted -> observation (tier 0) is refused, tier stays 2', () => updateRefused('upromo0', REP.promoted, 0, 'promoted', 'observation'));
test('update: promoted -> fact (tier 1) is refused, tier stays 2', () => updateRefused('upromo1', REP.promoted, 1, 'promoted', 'fact'));
test('update: fact -> trait (tier 3) is refused', () => updateRefused('ufact3', REP.fact, 3, 'fact', 'trait'));
test('update: observation -> trait (tier 3) is refused', () => updateRefused('uobs3', REP.observation, 3, 'observation', 'trait'));
test('update: observation -> proposed under the gate (1 day) is refused', () => updateRefused('uobs2', { tier: 0, sightingDays: DAYS1 }, 2, 'observation', 'proposed'));
test('update: dropped -> fact (tier 1) is refused', () => updateRefused('udrop1', REP.dropped, 1, 'dropped', 'fact'));
test('update: tier 7 is refused and nothing is written', () => updateRefused('ut7', REP.observation, 7, 'observation', 'tier 7'));
test('update: tier -1 is refused and nothing is written', () => updateRefused('utm1', REP.observation, -1, 'observation', 'tier -1'));
test("update: tier 'abc' is refused and nothing is written", () => updateRefused('utabc', REP.observation, 'abc', 'observation', 'tier abc'));

function updateAccepted(id, shape, tier) {
  writeCandidates([row(id, shape)]);
  const res = updateCandidate(id, { tier });
  assert.strictEqual(res.tier, tier);
  assert.strictEqual(stored(id).tier, tier);
  assert(!('state' in stored(id)), 'no state field is ever stored');
}

test('update: observation -> fact with no repo and 1 day (the run-all path)', () => updateAccepted('uok01', { tier: 0, sightingDays: DAYS1 }, 1));
test('update: observation -> proposed with 3 days', () => updateAccepted('uok02', REP.observation, 2));
test('update: fact -> proposed with 3 days', () => updateAccepted('uok12', REP.fact, 2));
test('update: fact -> observation', () => updateAccepted('uok10', REP.fact, 0));
test('update: proposed -> fact', () => updateAccepted('uok21', REP.proposed, 1));
test('update: proposed -> observation', () => updateAccepted('uok20', REP.proposed, 0));

for (const s of ['promoted', 'trait', 'dropped']) {
  test(`update: identity save (same tier, new text) works on a ${s} row`, () => {
    const id = `uid${s}`;
    writeCandidates([row(id, REP[s])]);
    const res = updateCandidate(id, { tier: REP[s].tier, text: `Edited ${s} text.` });
    assert.strictEqual(res.text, `Edited ${s} text.`);
    assert.strictEqual(stored(id).tier, REP[s].tier);
    assert.strictEqual(stateOf(stored(id)), s);
  });
}

// ── 3d. deleteCandidate ──────────────────────────────────────────────────────

for (const s of Object.keys(REP)) {
  test(`delete: ${s} -> tombstoned`, () => {
    const id = `del${s}`;
    writeCandidates([row(id, REP[s])]);
    assert.strictEqual(deleteCandidate(id).success, true);
    assert.strictEqual(getCandidate(id), null);
    assert(loadDeletedIds().has(id));
  });
}

// ── 4. Surfaces ──────────────────────────────────────────────────────────────

let dash = null;

function startDashboard() {
  const port = 30000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [DASHBOARD, '--port', String(port)], {
    env: { ...process.env, AGNOSTIC_STORAGE: TMP_STORAGE, AGNOSTIC_EXAMPLES_DIR: TMP_EXAMPLES },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`dashboard did not start in 15 s: ${out}`)); }, 15000);
    const onData = (d) => {
      out += d;
      const m = out.match(/live at http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
      else if (/already running/.test(out)) { clearTimeout(timer); child.kill(); reject(new Error('port held by another dashboard')); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`dashboard exited ${code}: ${out}`)); });
  });
}

function request(method, pathname, body) {
  assert(dash, 'dashboard is not running');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'X-Dashboard-Token': dash.token || '' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: dash.port, method, path: pathname, headers, timeout: 10000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, text: buf, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

const HTTP_FIXTURES = [
  row('hpromo', REP.promoted),
  row('hobs', REP.observation),
  row('hfact', { tier: 1, sightingDays: DAYS1 })
];

test('HTTP: the served page carries the token and #ladder-data equal to the ladder module', async () => {
  writeCandidates(HTTP_FIXTURES);
  dash = await startDashboard();
  const page = await request('GET', '/');
  assert.strictEqual(page.status, 200);
  const token = page.text.match(/const DASHBOARD_TOKEN = '([0-9a-f]{48})'/);
  assert(token, 'DASHBOARD_TOKEN must be injected');
  dash.token = token[1];
  const block = page.text.match(/<script type="application\/json" id="ladder-data">([\s\S]*?)<\/script>/);
  assert(block, '#ladder-data block must exist');
  assert.deepStrictEqual(JSON.parse(block[1]), { labels: LADDER_STATE_LABELS, tiers: STATE_TIER });
});

test('HTTP: POST /api/candidate/update demoting a promoted row is 409 with the contract body', async () => {
  writeCandidates(HTTP_FIXTURES);
  const res = await request('POST', '/api/candidate/update', { id: 'hpromo', tier: 0 });
  assert.strictEqual(res.status, 409, res.text);
  assert.deepStrictEqual(Object.keys(res.json), ['error', 'current', 'requested', 'allowed', 'message']);
  assert.strictEqual(res.json.error, 'illegal_transition');
  assert.strictEqual(res.json.current, 'promoted');
  assert.strictEqual(res.json.requested, 'observation');
  assert.deepStrictEqual(res.json.allowed, ['tombstoned']);
  assert(typeof res.json.message === 'string' && res.json.message.length > 0);
  assert.strictEqual(stored('hpromo').tier, 2);
});

test('HTTP: POST /api/candidate/update success item gains state fields (nothing stored)', async () => {
  writeCandidates(HTTP_FIXTURES);
  const res = await request('POST', '/api/candidate/update', { id: 'hfact', tier: 1, text: 'Edited over HTTP.' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.success, true);
  assert.strictEqual(res.json.item.state, 'fact');
  assert.strictEqual(res.json.item.state_label, LADDER_STATE_LABELS.fact);
  assert.deepStrictEqual(res.json.item.allowed_next, allowedNext(stored('hfact')));
  const s = stored('hfact');
  assert(!('state' in s) && !('allowed_next' in s) && !('state_label' in s), 'read fields must not be stored');
});

test('HTTP: POST /api/candidate/approve on an observation is 409; the real global-rules.md is byte-identical', async () => {
  writeCandidates(HTTP_FIXTURES);
  const before = fs.readFileSync(REAL_RULES_FILE);
  try {
    const res = await request('POST', '/api/candidate/approve', { id: 'hobs' });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.json.error, 'illegal_transition');
    assert.strictEqual(res.json.current, 'observation');
    assert.strictEqual(res.json.requested, 'promoted');
    assert.deepStrictEqual(res.json.allowed, allowedNext(stored('hobs')));
    assert(fs.readFileSync(REAL_RULES_FILE).equals(before), 'real global-rules.md must not change');
  } finally {
    if (!fs.readFileSync(REAL_RULES_FILE).equals(before)) fs.writeFileSync(REAL_RULES_FILE, before);
  }
});

test('HTTP: POST /api/candidate/approve on an unknown id stays 400', async () => {
  const res = await request('POST', '/api/candidate/approve', { id: 'no-such-candidate' });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.json.error, 'unknown-candidate');
});

test('HTTP: GET /api/candidate returns state and allowed_next for a fact', async () => {
  writeCandidates(HTTP_FIXTURES);
  const res = await request('GET', '/api/candidate?id=hfact');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.state, 'fact');
  assert.deepStrictEqual(res.json.allowed_next, allowedNext(HTTP_FIXTURES[2]));
});

test('CLI: distill --approve on an observation exits 2 with a JSON refusal; unknown id exits 1', () => {
  writeCandidates(HTTP_FIXTURES);
  const rules = tempRules();
  const before = fs.readFileSync(rules);
  const env = { ...process.env, AGNOSTIC_STORAGE: TMP_STORAGE, AGNOSTIC_EXAMPLES_DIR: TMP_EXAMPLES };
  const refused = spawnSync(process.execPath, [DISTILL, '--approve', 'hobs', '--rules-file', rules], { env, encoding: 'utf8' });
  assert.strictEqual(refused.status, 2, refused.stderr);
  assert(refused.stderr.includes('[Distill] Approve refused for hobs:'), refused.stderr);
  assert(refused.stderr.includes('"error":"illegal_transition"'), refused.stderr);
  const line = refused.stderr.split('\n').find(l => l.startsWith('{'));
  assert.deepStrictEqual(Object.keys(JSON.parse(line)), ['error', 'current', 'requested', 'allowed']);
  assert(fs.readFileSync(rules).equals(before), 'rules file must be unchanged');
  const unknown = spawnSync(process.execPath, [DISTILL, '--approve', 'no-such-candidate', '--rules-file', rules], { env, encoding: 'utf8' });
  assert.strictEqual(unknown.status, 1, unknown.stderr);
});

test('UI: the tier select has no hardcoded options; options and Approve derive from allowed_next', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools', 'dashboard', 'dashboard.html'), 'utf8');
  const select = html.match(/<select id="c-edit-tier"[^>]*>([\s\S]*?)<\/select>/);
  assert(select, '#c-edit-tier must exist');
  assert(!/<option value="[0-3]"/.test(select[1]), 'no hardcoded tier options');
  const modal = html.slice(html.indexOf('async function openCandidateEditModal'), html.indexOf('function closeCandidateEditModal'));
  assert(modal.length > 0, 'openCandidateEditModal must exist');
  assert(/item\.allowed_next/.test(modal), 'options must come from item.allowed_next');
  assert(/allowed_next \|\| \[\]\)\.includes\('promoted'\)/.test(modal), 'Approve must show only when promoted is allowed');
  assert.strictEqual(html.split('__LADDER_DATA__').length - 1, 1, 'one ladder-data placeholder');
  assert(/item\.state_label/.test(html), 'card tag must use item.state_label');
});

test('Shape: getErrorsData() items over the real ledger carry state and allowed_next (read-only)', () => {
  const { getErrorsData } = require('../../tools/dashboard/dashboard.cjs');
  const data = getErrorsData();
  for (const item of data.items) {
    assert(LADDER_STATES.includes(item.state), `${item.id}: state ${item.state}`);
    assert.strictEqual(item.state_label, LADDER_STATE_LABELS[item.state]);
    assert.deepStrictEqual(item.allowed_next, allowedNext(item));
  }
  console.log(`      (checked=${data.items.length} of ${data.total} ledger rows)`);
});

// ── run ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('[reg-ladder] Distillation ladder state machine\n');
  let passed = 0;
  let failed = 0;
  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${err && err.message}`);
      }
    }
  } finally {
    if (dash && dash.child) dash.child.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n[reg-ladder] ${passed} passed / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
