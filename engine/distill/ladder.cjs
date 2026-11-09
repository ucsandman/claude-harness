/**
 * engine/distill/ladder.cjs — the distillation ladder as an explicit state machine.
 *
 * A candidate record in storage/candidates.jsonl carries its lifecycle in three
 * stored fields (tier number, CANDIDATES.md status string, promoted flag) plus
 * the tombstone set in storage/deleted-candidates.json. This module is the one
 * place that turns those fields into a state and says which moves are legal.
 *
 * Existing ledger rows are read-only legacy: the state is derived on read, no
 * `state` field is ever stored, and nothing here rewrites a row.
 *
 * Pure: no fs, no env, no requires, so it is safe to load from any module and
 * from tests that juggle require.cache (run-all 4b).
 *
 * Writers call assertTransition before they change a tier. Refusals surface as
 * HTTP 409 (tools/dashboard/dashboard.cjs) and CLI exit 2 (distill.cjs --approve).
 * Harvest imports from curated sources (CANDIDATES.md, global-rules.md) are not
 * table edges: the curated file is the authority, so they are not guarded.
 */

const LADDER_STATES = Object.freeze([
  'observation', // T0: a raw sighting
  'fact',        // T1: repo-specific fact
  'proposed',    // T2: candidate rule awaiting human approval
  'promoted',    // T2: written to Learned Rules in core/rules/global-rules.md
  'trait',       // T3: hand-curated disposition (import only)
  'dropped',     // disconfirmed in CANDIDATES.md (import only)
  'tombstoned'   // deleted; listed in deleted-candidates.json, never resurfaces
]);

const TIER_VALUES = Object.freeze([0, 1, 2, 3]);
const STATUS_VALUES = Object.freeze(['watching', 'promoted', 'dropped']);

// The tier a state is stored as. dropped keeps whatever tier it was imported
// with and tombstoned has no row, so neither has an entry.
const STATE_TIER = Object.freeze({ observation: 0, fact: 1, proposed: 2, promoted: 2, trait: 3 });

// Reachable only through a harvest import, never through a table edge.
const IMPORT_ONLY_STATES = Object.freeze(['trait', 'dropped']);

// Moving INTO these needs RULE_GATE_DAYS distinct sighting days.
const GATED_STATES = Object.freeze(['proposed', 'promoted']);
const RULE_GATE_DAYS = 3;

const LADDER_TRANSITIONS = Object.freeze({
  observation: Object.freeze(['fact', 'proposed', 'tombstoned']),
  fact: Object.freeze(['observation', 'proposed', 'promoted', 'tombstoned']),
  proposed: Object.freeze(['observation', 'fact', 'promoted', 'tombstoned']),
  promoted: Object.freeze(['tombstoned']),
  trait: Object.freeze(['tombstoned']),
  dropped: Object.freeze(['tombstoned']),
  tombstoned: Object.freeze([])
});

const TERMINAL_STATES = Object.freeze(LADDER_STATES.filter(s => LADDER_TRANSITIONS[s].length === 0));

const LADDER_STATE_LABELS = Object.freeze({
  observation: 'T0 · Observation',
  fact: 'T1 · Repo Fact',
  proposed: 'T2 · Proposed rule (awaiting approval)',
  promoted: 'T2 · Learned rule (in global-rules.md)',
  trait: 'T3 · Trait (hand-curated)',
  dropped: 'Dropped (disconfirmed)',
  tombstoned: 'Deleted (tombstoned)'
});

/**
 * Derives the state of a stored row. Precedence: promoted flag, then status
 * 'dropped', then the tier (3 trait, 2 promoted-or-proposed by status, 1 fact,
 * anything else, including legacy non-number tiers, observation).
 */
function stateOf(item) {
  const c = item || {};
  if (c.promoted === true) return 'promoted';
  if (c.status === 'dropped') return 'dropped';
  if (c.tier === 3) return 'trait';
  if (c.tier === 2) return c.status === 'promoted' ? 'promoted' : 'proposed';
  if (c.tier === 1) return 'fact';
  return 'observation';
}

/** The state a tier write requests; undefined outside TIER_VALUES. */
function stateForTier(tier) {
  switch (tier) {
    case 0: return 'observation';
    case 1: return 'fact';
    case 2: return 'proposed';
    case 3: return 'trait';
    default: return undefined;
  }
}

function distinctDays(item) {
  const days = item && Array.isArray(item.sightingDays) ? item.sightingDays : [];
  return new Set(days.filter(d => typeof d === 'string' && d)).size;
}

function meetsRuleGate(item) {
  return distinctDays(item) >= RULE_GATE_DAYS;
}

/** Table-only next states (no gate). */
function nextStates(state) {
  return LADDER_STATES.includes(state) ? LADDER_TRANSITIONS[state].slice() : [];
}

/**
 * Gate-aware. An identity move (from === to) is a no-op success; otherwise the
 * edge must be in the table and, when it enters a gated state, the item must
 * meet the rule gate.
 */
function canTransition(from, to, item) {
  if (!LADDER_STATES.includes(from) || !LADDER_STATES.includes(to)) return false;
  if (from === to) return true;
  if (!LADDER_TRANSITIONS[from].includes(to)) return false;
  if (GATED_STATES.includes(to) && !meetsRuleGate(item)) return false;
  return true;
}

/** Gate-aware legal next states for a stored row. */
function allowedNext(item) {
  const from = stateOf(item);
  return nextStates(from).filter(to => canTransition(from, to, item));
}

function refusalReason(from, to, item) {
  if (!LADDER_STATES.includes(to)) {
    return `${to === undefined ? 'the requested value' : to} is not a ladder state (tiers ${TIER_VALUES.join(', ')})`;
  }
  if (!LADDER_STATES.includes(from)) return `${from} is not a ladder state`;
  if (!LADDER_TRANSITIONS[from].includes(to)) {
    return from === 'tombstoned'
      ? 'a tombstoned candidate never resurfaces'
      : `the ladder has no ${from} -> ${to} edge`;
  }
  return `needs ${RULE_GATE_DAYS} distinct sighting days (has ${distinctDays(item)})`;
}

class IllegalTransitionError extends Error {
  constructor({ current, requested, allowed, reason }) {
    const allowedList = Array.isArray(allowed) ? allowed : [];
    super(`Cannot move a candidate from ${current} to ${requested === undefined ? 'an unknown state' : requested}: ${reason}. Allowed: ${allowedList.length ? allowedList.join(', ') : 'none'}.`);
    this.name = 'IllegalTransitionError';
    this.code = 'illegal_transition';
    this.current = current;
    this.requested = requested === undefined ? null : requested;
    this.allowed = allowedList;
  }

  toJSON() {
    return {
      error: 'illegal_transition',
      current: this.current,
      requested: this.requested,
      allowed: this.allowed,
      message: this.message
    };
  }
}

/** Returns silently on a legal (or identity) move; throws IllegalTransitionError otherwise. */
function assertTransition(from, to, item) {
  if (canTransition(from, to, item)) return;
  const allowed = item ? allowedNext(item) : nextStates(from);
  throw new IllegalTransitionError({ current: from, requested: to, allowed, reason: refusalReason(from, to, item) });
}

module.exports = {
  LADDER_STATES,
  TIER_VALUES,
  STATUS_VALUES,
  STATE_TIER,
  IMPORT_ONLY_STATES,
  GATED_STATES,
  RULE_GATE_DAYS,
  LADDER_TRANSITIONS,
  TERMINAL_STATES,
  LADDER_STATE_LABELS,
  IllegalTransitionError,
  stateOf,
  stateForTier,
  meetsRuleGate,
  canTransition,
  assertTransition,
  nextStates,
  allowedNext
};
