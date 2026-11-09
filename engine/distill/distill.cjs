#!/usr/bin/env node
/**
 * distill.cjs — Automated Daily Reflection & Error Distillation Engine.
 *
 * Implements the 4-Tier Promotion Ladder & Anti-Bloat Pruning:
 *   Tier 0 · Observation (Raw sighting)
 *   Tier 1 · Fact (Repo-specific quirk, prevents repeat blunder)
 *   Tier 2 · Rule (Universal constraint: 3+ sightings on 3+ separate days, max 5 core)
 *   Tier 3 · Trait (Guiding disposition when no rule covers the case)
 *   Tier E · Few-Shot Example (Converted failure fixtures to prevent prompt soup)
 *
 * Enforces the Refusal-to-Promotion Ratio & Conflict Matrix.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { auditRuleBudget, pushToExamples, MAX_CORE_PRINCIPLES } = require('./prune.cjs');
const { stateOf, canTransition, assertTransition, allowedNext } = require('./ladder.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = process.env.AGNOSTIC_STORAGE || path.join(ROOT, 'storage');
const CANDIDATES_FILE = path.join(STORAGE, 'candidates.jsonl');
const CORRECTIONS_FILE = path.join(STORAGE, 'corrections.jsonl');
const PROPOSAL_FILE = path.join(STORAGE, 'distill-PROPOSAL.md');
const DIGEST_FILE = path.join(STORAGE, 'distill-digest.json');
const DELETED_FILE = path.join(STORAGE, 'deleted-candidates.json');
const CORE_RULES_FILE = path.join(ROOT, 'core', 'rules', 'global-rules.md');
const LEARNED_HEADING = '## Learned Rules (Self-Promoted via Distillation Ladder)';

function hashFingerprint(text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function loadCandidates() {
  if (!fs.existsSync(CANDIDATES_FILE)) return new Map();
  const lines = fs.readFileSync(CANDIDATES_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      // Normalise here, once: legacy/hand-edited records reach every downstream
      // consumer (promotion gates, prune, examples) and must not crash them.
      if (!item || !item.id || typeof item.text !== 'string' || !item.text.trim()) continue;
      if (!Array.isArray(item.sightingDays)) item.sightingDays = [];
      if (typeof item.tier !== 'number') item.tier = 0;
      map.set(item.id, item);
    } catch (_) {}
  }
  return map;
}

// Same parse as harvest.cjs loadDeletedIds. Kept local on purpose: requiring
// harvest.cjs at load would pin its STORAGE in require.cache, which breaks
// tests that re-require distill against a temp AGNOSTIC_STORAGE (run-all 4b).
function loadDeletedIds() {
  if (!fs.existsSync(DELETED_FILE)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : Object.keys(raw));
  } catch (_) {
    return new Set();
  }
}

function saveCandidates(map) {
  if (!fs.existsSync(STORAGE)) fs.mkdirSync(STORAGE, { recursive: true });
  const lines = Array.from(map.values()).map(v => JSON.stringify(v));
  fs.writeFileSync(CANDIDATES_FILE, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

function harvestCorrections() {
  if (!fs.existsSync(CORRECTIONS_FILE)) return [];
  const lines = fs.readFileSync(CORRECTIONS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // A line with no correction text is a log entry, not a candidate.
      // A line with no correction text is a log entry, not a candidate.
      if (ev && typeof ev.correction === 'string' && ev.correction.trim()) events.push(ev);
    } catch (_) {}
  }
  return events;
}

function harvestRepoErrors() {
  const errors = [];
  const errorsMd = path.join(ROOT, 'docs', 'ERRORS.md');
  if (fs.existsSync(errorsMd)) {
    const content = fs.readFileSync(errorsMd, 'utf8');
    const sections = content.split(/^###\s+/m).slice(1);
    for (const sec of sections) {
      const lines = sec.trim().split('\n');
      const title = lines[0];
      errors.push({
        type: 'documented_error',
        title,
        text: sec,
        date: new Date().toISOString().slice(0, 10)
      });
    }
  }
  return errors;
}

function runDistillation() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[Distill] Starting daily self-maintenance run for ${today}...`);

  const candidates = loadCandidates();
  const corrections = harvestCorrections();
  const repoErrors = harvestRepoErrors();
  const deleted = loadDeletedIds();

  const observations = [];
  const promotedFacts = [];
  const candidateRules = [];
  const examplesMigrated = [];
  const refusedItems = [];

  // 1. Process Corrections
  for (const cor of corrections) {
    const fp = hashFingerprint(cor.correction);
    // Tombstoned is terminal (LADDER_TRANSITIONS.tombstoned is []): a deleted id never comes back.
    if (deleted.has(fp)) continue;
    const existing = candidates.get(fp) || {
      id: fp,
      text: cor.correction,
      firstSeen: today,
      sightingDays: [],
      tier: 0,
      client: cor.client,
      repo: cor.repo
    };

    if (!existing.sightingDays.includes(today)) {
      existing.sightingDays.push(today);
    }
    candidates.set(fp, existing);
    observations.push(existing);
  }

  // 2. Process Documented Errors
  for (const err of repoErrors) {
    const fp = hashFingerprint(err.title);
    // Tombstoned is terminal (LADDER_TRANSITIONS.tombstoned is []): a deleted id never comes back.
    if (deleted.has(fp)) continue;
    const existing = candidates.get(fp) || {
      id: fp,
      text: err.title,
      firstSeen: today,
      sightingDays: [],
      tier: 0,
      client: 'all'
    };
    if (!existing.sightingDays.includes(today)) {
      existing.sightingDays.push(today);
    }
    candidates.set(fp, existing);
  }

  // 3. Collect Tier 2 Candidates
  const rawRuleCandidates = [];
  for (const [id, item] of candidates.entries()) {
    const count = item.sightingDays.length;

    // Gate 0 -> 1: Repo Fact (Single sighting with named repo context)
    if (stateOf(item) === 'observation' && item.repo && count >= 1) {
      assertTransition('observation', 'fact', item);
      item.tier = 1;
      promotedFacts.push(item);
    }

    // Gate 1 -> 2: Universal Rule check (3+ sightings on 3+ distinct days).
    // Only observation or fact may be proposed; dropped, trait and promoted rows
    // have no proposed edge, and an already-proposed row is not re-proposed.
    const state = stateOf(item);
    if (state !== 'proposed' && canTransition(state, 'proposed', item)) {
      rawRuleCandidates.push(item);
    } else if (count === 2 && item.tier === 1) {
      refusedItems.push({
        item,
        reason: 'Sighted 2 days (requires 3 distinct sighting days for Rule promotion)'
      });
    }
  }

  // 4. Run Rule Budget, Ceiling & Conflict Audit (The Pruning Step)
  const pruneAudit = auditRuleBudget(rawRuleCandidates);

  for (const analysis of pruneAudit.candidateAnalyses) {
    const item = candidates.get(analysis.id);
    if (!item) continue;

    if (analysis.recommendation === 'promote_rule') {
      if (candidateRules.length < 2) {
        assertTransition(stateOf(item), 'proposed', item);
        item.tier = 2;
        candidateRules.push(item);
      } else {
        refusedItems.push({
          item,
          reason: 'Ceiling reached: maximum 2 rule promotions permitted per run to prevent context bloat'
        });
      }
    } else if (analysis.recommendation === 'push_to_examples') {
      const exRes = pushToExamples(item);
      examplesMigrated.push({
        item,
        path: exRes.path,
        reason: analysis.rationale
      });
    }
  }

  saveCandidates(candidates);

  // 5. Generate distill-PROPOSAL.md
  let proposalMd = `# Daily Distillation Proposal — ${today}\n\n`;
  proposalMd += `> Generated by Agnostic AI Distillation Engine. Review below and approve promotions.\n\n`;

  proposalMd += `## Health Metrics\n`;
  proposalMd += `- **Total Active Candidates:** ${candidates.size}\n`;
  proposalMd += `- **Active Core Principles:** ${pruneAudit.activeCount} / ${pruneAudit.ceiling}\n`;
  proposalMd += `- **New Observations (Tier 0):** ${observations.length}\n`;
  proposalMd += `- **Promoted to Repo Facts (Tier 1):** ${promotedFacts.length}\n`;
  proposalMd += `- **Candidates for Universal Rules (Tier 2):** ${candidateRules.length}\n`;
  proposalMd += `- **Migrated to Few-Shot Examples (Tier E):** ${examplesMigrated.length}\n`;
  proposalMd += `- **Refused / Withheld (Gating Healthy):** ${refusedItems.length}\n\n`;

  proposalMd += `## Recommended Rule Promotions (Tier 2)\n`;
  if (candidateRules.length === 0) {
    proposalMd += `*None today. (No candidate met the 3-day multi-sighting and rule ceiling gates)*\n\n`;
  } else {
    for (const r of candidateRules) {
      proposalMd += `### Proposed Rule: \`${r.text}\`\n`;
      proposalMd += `- **Sightings (${r.sightingDays.length} days):** ${r.sightingDays.join(', ')}\n`;
      proposalMd += `- **Client / Source:** ${r.client}\n`;
      proposalMd += `- **Proposed Action:** Append to \`core/rules/global-rules.md\` and run \`node engine/sync/sync.cjs\`\n\n`;
    }
  }

  proposalMd += `## Migrated to Few-Shot Examples (Anti-Bloat & Conflict Prevention)\n`;
  if (examplesMigrated.length === 0) {
    proposalMd += `*No rules converted to examples in this run.*\n\n`;
  } else {
    for (const ex of examplesMigrated) {
      proposalMd += `- **${ex.item.text}**\n  - *Reason:* ${ex.reason}\n  - *Example Fixture:* \`${path.basename(ex.path)}\`\n`;
    }
    proposalMd += `\n`;
  }

  proposalMd += `## Refused Candidates & Gated Checks\n`;
  if (refusedItems.length === 0) {
    proposalMd += `*No candidates currently pending gate review.*\n\n`;
  } else {
    for (const ref of refusedItems) {
      proposalMd += `- **${ref.item.text}**: REFUSED (${ref.reason})\n`;
    }
    proposalMd += `\n`;
  }

  fs.writeFileSync(PROPOSAL_FILE, proposalMd, 'utf8');

  // 6. Generate JSON digest for dashboard UI
  const digest = {
    date: today,
    stats: {
      candidatesTotal: candidates.size,
      activeCorePrinciples: pruneAudit.activeCount,
      principlesCeiling: pruneAudit.ceiling,
      observationsCount: observations.length,
      promotedFactsCount: promotedFacts.length,
      candidateRulesCount: candidateRules.length,
      examplesMigratedCount: examplesMigrated.length,
      refusedCount: refusedItems.length
    },
    candidateRules,
    examplesMigrated,
    promotedFacts,
    refusedItems,
    allCandidates: Array.from(candidates.values())
  };
  fs.writeFileSync(DIGEST_FILE, JSON.stringify(digest, null, 2), 'utf8');

  console.log(`[Distill] Complete.`);
  console.log(`  - Active Principles: ${pruneAudit.activeCount} / ${pruneAudit.ceiling}`);
  console.log(`  - Migrated to Examples: ${examplesMigrated.length}`);
  console.log(`  - Proposal written: ${PROPOSAL_FILE}`);
  console.log(`  - Digest written: ${DIGEST_FILE}`);

  return digest;
}

/**
 * Closes the promotion loop: writes an approved candidate into the SSOT
 * (core/rules/global-rules.md) so `node engine/sync/sync.cjs` can fan it out.
 * Idempotent — a rule whose text is already present is never appended twice.
 */
function approveCandidate(id, rulesFile = CORE_RULES_FILE) {
  const candidates = loadCandidates();
  const item = candidates.get(id);
  if (!item) return { ok: false, reason: 'unknown-candidate', id };
  // The ladder decides before any rules-file read or write. promoted -> promoted
  // is identity, so the idempotent re-approve path below is unchanged.
  const current = stateOf(item);
  if (!canTransition(current, 'promoted', item)) {
    let message = '';
    try { assertTransition(current, 'promoted', item); } catch (err) { message = err.message; }
    return { ok: false, reason: 'illegal_transition', id, current, requested: 'promoted', allowed: allowedNext(item), message };
  }
  if (!fs.existsSync(rulesFile)) return { ok: false, reason: 'missing-rules-file', path: rulesFile };

  const text = String(item.text || '').trim();
  if (!text) return { ok: false, reason: 'empty-candidate-text', id };

  const md = fs.readFileSync(rulesFile, 'utf8');
  const headIdx = md.indexOf(LEARNED_HEADING);
  if (headIdx === -1) return { ok: false, reason: 'missing-learned-section', path: rulesFile };

  const today = new Date().toISOString().slice(0, 10);
  const markPromoted = () => {
    item.tier = Math.max(item.tier || 0, 2);
    item.promoted = true;
    item.promotedAt = item.promotedAt || today;
    candidates.set(id, item);
    // harvest owns the candidates+digest write path; reuse it so the dashboard
    // overview is not stale until the next harvest run.
    require('../harvest/harvest.cjs').saveCandidatesMap(candidates);
  };

  // Only the Learned Rules section counts as "already promoted" \u2014 the same words
  // appearing in the prose above it are not a promotion.
  const rest = md.slice(headIdx + LEARNED_HEADING.length);
  const nextHeadRel = rest.search(/\n##\s/);
  const insertAt = nextHeadRel === -1 ? md.length : headIdx + LEARNED_HEADING.length + nextHeadRel;

  if (md.slice(headIdx, insertAt).includes(text)) {
    markPromoted();
    return { ok: true, id, alreadyPresent: true, path: rulesFile, state: stateOf(item), allowed_next: allowedNext(item) };
  }

  const labels = md.match(/^- \*\*L(\d+)\b/gm) || [];
  const nextNumber = labels.reduce((max, l) => Math.max(max, parseInt(l.replace(/\D/g, ''), 10) || 0), 0) + 1;
  const label = `L${nextNumber}`;
  const bullet = `- **${label} (${today}) \u2014 ${text}**\n`;

  const before = md.slice(0, insertAt).replace(/\s*$/, '\n');
  const after = md.slice(insertAt).replace(/^\n+/, '');

  fs.writeFileSync(rulesFile, `${before}\n${bullet}${after ? '\n' + after : ''}`, 'utf8');
  markPromoted();
  return { ok: true, id, label, path: rulesFile, appended: bullet.trim(), state: stateOf(item), allowed_next: allowedNext(item) };
}

if (require.main === module) {
  const approveIdx = process.argv.indexOf('--approve');
  if (approveIdx !== -1) {
    const id = process.argv[approveIdx + 1];
    const rulesIdx = process.argv.indexOf('--rules-file');
    const rulesFile = rulesIdx !== -1 ? process.argv[rulesIdx + 1] : CORE_RULES_FILE;
    const res = approveCandidate(id, rulesFile);
    if (res.ok) {
      console.log(`[Distill] Approved ${id}${res.alreadyPresent ? ' (already present — no change)' : ` as ${res.label}`} -> ${res.path}`);
      console.log('  Next: node engine/sync/sync.cjs');
    } else if (res.reason === 'illegal_transition') {
      // Exit 2 = refused by the ladder; exit 1 = broken (unknown id, missing file).
      console.error(`[Distill] Approve refused for ${id}: ${res.message}`);
      console.error(JSON.stringify({ error: 'illegal_transition', current: res.current, requested: res.requested, allowed: res.allowed }));
      process.exit(2);
    } else {
      console.error(`[Distill] Approve failed for ${id}: ${res.reason}`);
    }
    process.exit(res.ok ? 0 : 1);
  }
  runDistillation();
}

module.exports = { runDistillation, hashFingerprint, approveCandidate, CORE_RULES_FILE };
