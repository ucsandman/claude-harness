#!/usr/bin/env node
/**
 * tools/dashboard/dashboard.cjs — Unified Agnostic AI Command Center.
 *
 * Serves the interactive browser UI for:
 *   1. Error & Distillation Explorer (877+ harvested records across agents)
 *   2. Harness Rules, Traits & Declarative Safety Guards
 *   3. Global & Project-Specific Skills Matrix with 1-Click Optimal Recommendations
 *   4. Governed Decisions & Audit Stream
 *   5. Maintenance Routines & On-Demand Execution
 *
 * Usage:
 *   node tools/dashboard/dashboard.cjs --open
 *   node tools/dashboard/dashboard.cjs --port 7842
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML_FILE = path.join(__dirname, 'dashboard.html');
const STORAGE = path.join(ROOT, 'storage');

const portArgIndex = process.argv.indexOf('--port');
const PORT_ARG = portArgIndex > -1 ? parseInt(process.argv[portArgIndex + 1], 10) : NaN;
let PORT = PORT_ARG || parseInt(process.env.PORT || '7842', 10);
const OPEN_FLAG = process.argv.includes('--open');

// Sent on every response so a second launch can tell "our dashboard is already
// up" from "some other project owns this port". Without it, EADDRINUSE used to
// open a browser at whatever app happened to be listening.
const ID_HEADER = 'x-agnostic-dashboard';

function isOurDashboard(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'HEAD', path: '/', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(Boolean(res.headers[ID_HEADER]));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Binding to 127.0.0.1 does not stop any web page the operator visits from
// POSTing to this port. Same defence as agent/web/server.py: a per-process
// token the served HTML carries, plus a loopback Origin/Referer check.
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function authorized(req) {
  const headers = (req && req.headers) || {};
  const supplied = Buffer.from(String(headers['x-dashboard-token'] || ''));
  const expected = Buffer.from(SESSION_TOKEN);
  if (supplied.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(supplied, expected)) return false;
  const source = headers.origin || headers.referer;
  if (source) {
    try {
      if (!LOOPBACK_HOSTS.has(new URL(source).hostname.replace(/^\[|\]$/g, ''))) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

// Dependencies from engine
const { runHarvest, getCandidate, updateCandidate, deleteCandidate } = require('../../engine/harvest/harvest.cjs');
const { consolidateSkills } = require('../../engine/skills/consolidate.cjs');
const {
  recommendSkillsForProject,
  listAllProjectsWithRecommendations,
  applyProjectRecommendations,
  toggleSkill,
  loadSkillsManifest,
  loadSkillsConfig
} = require('../../engine/skills/recommend.cjs');
const { run: runSync, loadSource, expandPath } = require('../../engine/sync/sync.cjs');
const { getStoredDashClawConfig, autoConfigureDashClaw, checkEndpointHealth } = require('../../engine/hooks/dashclaw-setup.cjs');
const { runDistillation, approveCandidate } = require('../../engine/distill/distill.cjs');
const { calculateLocalRisk, riskThresholds } = require('../../engine/hooks/dashclaw-guard.cjs');
const { auditHarnessBloat, applyBloatOptimizations } = require('../../engine/audit/bloat-audit.cjs');
const { getParityStatus } = require('../sync/parity.cjs');
const { stateOf, allowedNext, LADDER_STATE_LABELS, STATE_TIER } = require('../../engine/distill/ladder.cjs');

// Additive read fields so a human or an agent sees the ladder state and the
// legal next moves without re-deriving them. Nothing here is stored.
function withLadder(c) {
  const state = stateOf(c);
  return { ...c, state, state_label: LADDER_STATE_LABELS[state], allowed_next: allowedNext(c) };
}

function getOverviewData() {
  const digestFile = path.join(STORAGE, 'distill-digest.json');
  let digest = { stats: { candidatesTotal: 0, observationsCount: 0, promotedFactsCount: 0, candidateRulesCount: 0, refusedCount: 0 } };
  if (fs.existsSync(digestFile)) {
    try { digest = JSON.parse(fs.readFileSync(digestFile, 'utf8')); } catch (_) {}
  }

  const manifest = loadSkillsManifest();
  const config = loadSkillsConfig();
  const dashclaw = getStoredDashClawConfig();
  const targetsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'templates', 'targets.json'), 'utf8'));

  const skillsTotal = Object.keys(manifest).length;
  const skillsEnabled = Object.keys(manifest).filter(id => config.globalEnabled[id] !== false).length;

  let parity = { total: targetsConfig.targets.length, inSyncCount: 0, staleCount: targetsConfig.targets.length, allInSync: false };
  try {
    const status = getParityStatus();
    parity = { total: status.total, inSyncCount: status.inSyncCount, staleCount: status.staleCount, allInSync: status.allInSync };
  } catch (_) {}

  return {
    candidates: digest.stats || {},
    skills: { total: skillsTotal, enabled: skillsEnabled },
    targets: { total: targetsConfig.targets.length, active: targetsConfig.targets.length },
    parity,
    dashclaw: dashclaw || { configured: false },
    updatedAt: new Date().toISOString()
  };
}

function getErrorsData(query = {}) {
  const candidatesFile = path.join(STORAGE, 'candidates.jsonl');
  if (!fs.existsSync(candidatesFile)) {
    return { total: 0, items: [] };
  }

  const lines = fs.readFileSync(candidatesFile, 'utf8').trim().split('\n').filter(Boolean);
  let items = lines.map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);

  const search = (query.search || '').toLowerCase();
  const tier = query.tier;
  const kind = query.kind;
  const bucket = query.bucket;
  const repo = (query.repo || '').toLowerCase();

  if (tier !== undefined && tier !== 'all' && tier !== '') {
    items = items.filter(c => String(c.tier) === String(tier));
  }
  if (kind && kind !== 'all') {
    items = items.filter(c => c.kind === kind);
  }
  if (bucket && bucket !== 'all') {
    items = items.filter(c => c.bucket === bucket);
  }
  if (repo) {
    items = items.filter(c => (c.repo || '').toLowerCase().includes(repo));
  }
  if (search) {
    items = items.filter(c =>
      c.text.toLowerCase().includes(search) ||
      (c.repo && c.repo.toLowerCase().includes(search)) ||
      (c.tags && c.tags.some(t => t.toLowerCase().includes(search))) ||
      (c.bucket && c.bucket.toLowerCase().includes(search))
    );
  }

  return {
    total: items.length,
    items: items.slice(0, 500).map(withLadder) // cap for smooth rendering
  };
}

function getRulesData() {
  const globalRulesPath = path.join(ROOT, 'core', 'rules', 'global-rules.md');
  const traitsPath = path.join(ROOT, 'core', 'traits', 'traits.md');
  const guardsPath = path.join(ROOT, 'core', 'safety', 'guards.json');

  const rawRules = fs.existsSync(globalRulesPath) ? fs.readFileSync(globalRulesPath, 'utf8') : '';
  const rawTraits = fs.existsSync(traitsPath) ? fs.readFileSync(traitsPath, 'utf8') : '';
  let guards = {};
  if (fs.existsSync(guardsPath)) {
    try { guards = JSON.parse(fs.readFileSync(guardsPath, 'utf8')); } catch (_) {}
  }

  // Parse sections of global-rules.md
  const sections = [];
  const rawSections = rawRules.split(/^##\s+/m).slice(1);
  for (const s of rawSections) {
    const lines = s.trim().split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    sections.push({ title, content });
  }

  // Parse traits
  const traits = [];
  const rawTraitBlocks = rawTraits.split(/^###\s+/m).slice(1);
  for (const t of rawTraitBlocks) {
    const lines = t.trim().split('\n');
    const title = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    traits.push({ title, body });
  }

  return { sections, traits, guards, fullMarkdown: rawRules };
}

function getRoutinesData() {
  return [
    {
      id: 'distill',
      name: 'Daily Reflection & Distillation Pass',
      description: 'Gathers raw observations, evaluates promotion gates, generates proposal and digest.',
      schedule: 'Daily @ 00:00 UTC / on demand',
      lastRun: fs.existsSync(path.join(STORAGE, 'distill-digest.json')) ? fs.statSync(path.join(STORAGE, 'distill-digest.json')).mtime.toISOString() : 'Never',
      command: 'npm run distill'
    },
    {
      id: 'harvest',
      name: 'Cross-Agent Error & Candidate Harvester',
      description: 'Ingests latest sessions from Claude Code, Codex, agy, and user logs.',
      schedule: 'Continuous / on demand',
      lastRun: fs.existsSync(path.join(STORAGE, 'candidates.jsonl')) ? fs.statSync(path.join(STORAGE, 'candidates.jsonl')).mtime.toISOString() : 'Never',
      command: 'node engine/harvest/harvest.cjs'
    },
    {
      id: 'sync',
      name: 'Polyglot 18-Target Agreement Sync',
      description: 'Compiles single source of truth rules and traits to all configured AI client files.',
      schedule: 'On rule change / on demand',
      lastRun: new Date().toISOString(),
      command: 'npm run sync'
    },
    {
      id: 'skills_consolidate',
      name: 'Cross-Agent Skill Consolidation',
      description: 'Scans all client folders and synchronizes definitions into skills/definitions/.',
      schedule: 'On demand',
      lastRun: fs.existsSync(path.join(STORAGE, 'skills-manifest.json')) ? fs.statSync(path.join(STORAGE, 'skills-manifest.json')).mtime.toISOString() : 'Never',
      command: 'node engine/skills/consolidate.cjs'
    },
    {
      id: 'dashclaw_probe',
      name: 'DashClaw Governed Autonomy Probe',
      description: 'Verifies endpoint health, validates token, and refreshes agent identity.',
      schedule: 'Every 5 min / on launch',
      lastRun: new Date().toISOString(),
      command: 'npm run dashclaw:status'
    }
  ];
}

function executeRoutine(routineId, opts = {}) {
  switch (routineId) {
    case 'distill':
      return { success: true, result: runDistillation() };
    case 'harvest':
      return { success: true, result: runHarvest() };
    case 'sync':
      return { success: true, result: runSync({ check: false, force: Boolean(opts.force) }) };
    case 'skills_consolidate':
      return { success: true, result: consolidateSkills() };
    case 'dashclaw_probe':
      return { success: true, result: autoConfigureDashClaw() };
    default:
      throw new Error(`Unknown routine ID: ${routineId}`);
  }
}

function getDashClawFullConfig() {
  const config = getStoredDashClawConfig() || {
    configured: true,
    active: true,
    baseUrl: 'https://my-dashclaw.vercel.app',
    apiKey: '',
    agentId: 'agnostic-harness',
    agentName: 'Agnostic AI Harness',
    guardMode: 'enforce',
    defaultRiskThreshold: 50,
    autoDiscover: true,
    predictiveRiskEnabled: true,
    predictiveRiskThreshold: 60,
    autoScanBlock: true,
    actionCostThreshold: '0.50',
    outcomeTimeoutMinutes: 15,
    orgHalt: false,
    approvalPause: false,
    alertTelegram: '',
    alertDiscord: '',
    alertSlack: '',
    alertEmail: '',
    source: 'environment'
  };

  const guardsPath = path.join(ROOT, 'core', 'safety', 'guards.json');
  let guards = {};
  if (fs.existsSync(guardsPath)) {
    try { guards = JSON.parse(fs.readFileSync(guardsPath, 'utf8')); } catch (_) {}
  }

  return { config, guards };
}

function saveDashClawConfig(body) {
  const configStorage = path.join(STORAGE, 'dashclaw-config.json');
  const existing = getStoredDashClawConfig() || {};
  const updated = {
    ...existing,
    configured: true,
    active: body.active !== undefined ? Boolean(body.active) : true,
    baseUrl: (body.baseUrl || 'https://my-dashclaw.vercel.app').trim().replace(/\/$/, ''),
    apiKey: body.apiKey !== undefined ? body.apiKey.trim() : existing.apiKey,
    agentId: (body.agentId || 'agnostic-harness').trim(),
    agentName: (body.agentName || 'Agnostic AI Harness').trim(),
    guardMode: body.guardMode || 'enforce',
    defaultRiskThreshold: parseInt(body.defaultRiskThreshold || '50', 10),
    autoDiscover: body.autoDiscover !== undefined ? Boolean(body.autoDiscover) : true,
    predictiveRiskEnabled: body.predictiveRiskEnabled !== undefined ? Boolean(body.predictiveRiskEnabled) : true,
    predictiveRiskThreshold: parseInt(body.predictiveRiskThreshold || '60', 10),
    autoScanBlock: body.autoScanBlock !== undefined ? Boolean(body.autoScanBlock) : true,
    actionCostThreshold: (body.actionCostThreshold || '0.50').trim(),
    outcomeTimeoutMinutes: parseInt(body.outcomeTimeoutMinutes || '15', 10),
    orgHalt: Boolean(body.orgHalt),
    approvalPause: Boolean(body.approvalPause),
    alertTelegram: (body.alertTelegram || '').trim(),
    alertDiscord: (body.alertDiscord || '').trim(),
    alertSlack: (body.alertSlack || '').trim(),
    alertEmail: (body.alertEmail || '').trim(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(configStorage, JSON.stringify(updated, null, 2), 'utf8');

  // Also sync guards.json dashclaw section
  const guardsPath = path.join(ROOT, 'core', 'safety', 'guards.json');
  if (fs.existsSync(guardsPath)) {
    try {
      const guards = JSON.parse(fs.readFileSync(guardsPath, 'utf8'));
      if (!guards.guards) guards.guards = {};
      guards.guards.dashclaw = {
        enabled: updated.active,
        autoDiscover: updated.autoDiscover,
        defaultRiskThreshold: updated.defaultRiskThreshold,
        baseUrl: updated.baseUrl,
        predictiveRiskEnabled: updated.predictiveRiskEnabled,
        autoScanBlock: updated.autoScanBlock,
        orgHalt: updated.orgHalt
      };
      fs.writeFileSync(guardsPath, JSON.stringify(guards, null, 2), 'utf8');
    } catch (_) {}
  }

  return updated;
}

function getDashClawPolicies() {
  const guardsPath = path.join(ROOT, 'core', 'safety', 'guards.json');
  let guards = {};
  if (fs.existsSync(guardsPath)) {
    try { guards = JSON.parse(fs.readFileSync(guardsPath, 'utf8')); } catch (_) {}
  }

  const localStatePath = path.join(ROOT, '.dashclaw-local', 'state.json');
  let localRules = [];
  if (fs.existsSync(localStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      localRules = state.policyRules || [];
    } catch (_) {}
  }

  return {
    hardStops: (guards.guards && guards.guards.hardStops && guards.guards.hardStops.requireApprovalPatterns) || [],
    secretScan: (guards.guards && guards.guards.secretScan) || { enabled: true, blockedFiles: [], sensitivePatterns: [] },
    processControl: (guards.guards && guards.guards.processControl) || { protectedProcesses: [], blockedCommands: [] },
    customRules: localRules
  };
}

function saveDashClawPolicies(body) {
  const guardsPath = path.join(ROOT, 'core', 'safety', 'guards.json');
  let guards = {};
  if (fs.existsSync(guardsPath)) {
    try { guards = JSON.parse(fs.readFileSync(guardsPath, 'utf8')); } catch (_) {}
  }

  if (!guards.guards) guards.guards = {};

  if (body.hardStops && Array.isArray(body.hardStops)) {
    if (!guards.guards.hardStops) guards.guards.hardStops = {};
    guards.guards.hardStops.requireApprovalPatterns = body.hardStops;
  }

  if (body.secretScan) {
    guards.guards.secretScan = body.secretScan;
  }

  if (body.processControl) {
    guards.guards.processControl = body.processControl;
  }

  fs.writeFileSync(guardsPath, JSON.stringify(guards, null, 2), 'utf8');

  if (body.customRules && Array.isArray(body.customRules)) {
    const localStatePath = path.join(ROOT, '.dashclaw-local', 'state.json');
    let state = { version: 1, workspaces: [], projects: [], environments: [], connections: [], mappings: [], policyRules: [], pendingApprovals: [] };
    if (fs.existsSync(localStatePath)) {
      try { state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')); } catch (_) {}
    }
    state.policyRules = body.customRules;
    fs.writeFileSync(localStatePath, JSON.stringify(state, null, 2), 'utf8');
  }

  return getDashClawPolicies();
}

function getDashClawConnections() {
  const localStatePath = path.join(ROOT, '.dashclaw-local', 'state.json');
  let state = { connections: [] };
  if (fs.existsSync(localStatePath)) {
    try { state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')); } catch (_) {}
  }

  const defaultProviders = [
    { id: 'vercel', name: 'Vercel Deployments & Serverless', category: 'Deployment', defaultResource: 'my-app-web', enabled: true, icon: '▲' },
    { id: 'github', name: 'GitHub Repositories & CI/CD', category: 'Source & CI', defaultResource: 'owner/repository', enabled: true, icon: '🐙' },
    { id: 'neon', name: 'Neon Serverless PostgreSQL', category: 'Database', defaultResource: 'neon-primary-db', enabled: true, icon: '🐘' },
    { id: 'render', name: 'Render Web Services', category: 'Hosting', defaultResource: 'render-api-service', enabled: true, icon: '🚀' },
    { id: 'supabase', name: 'Supabase PostgreSQL & Auth', category: 'Database', defaultResource: 'supabase-core', enabled: true, icon: '⚡' },
    { id: 'stripe', name: 'Stripe Payments & Webhooks', category: 'Billing', defaultResource: 'stripe-live-ledger', enabled: true, icon: '💳' },
    { id: 'clerk', name: 'Clerk User Authentication', category: 'Auth', defaultResource: 'clerk-auth-instance', enabled: true, icon: '🔒' },
    { id: 'resend', name: 'Resend Transactional Email', category: 'Communication', defaultResource: 'resend-mailer', enabled: true, icon: '📧' },
    { id: 'sentry', name: 'Sentry Crash & Error Telemetry', category: 'Monitoring', defaultResource: 'sentry-agnostic', enabled: true, icon: '🚨' },
    { id: 'posthog', name: 'PostHog Analytics & Flags', category: 'Analytics', defaultResource: 'posthog-events', enabled: true, icon: '🦔' },
    { id: 'cloudflare_r2', name: 'Cloudflare R2 Object Storage', category: 'Storage', defaultResource: 'r2-artifacts', enabled: true, icon: '☁️' },
    { id: 'upstash', name: 'Upstash Redis & QStash Queue', category: 'Cache & Queue', defaultResource: 'upstash-redis-main', enabled: true, icon: '⚡' }
  ];

  const connections = (state.connections && state.connections.length > 0) ? state.connections : defaultProviders;
  return { connections };
}

function saveDashClawConnections(connectionsList) {
  const localStatePath = path.join(ROOT, '.dashclaw-local', 'state.json');
  let state = { version: 1, workspaces: [], projects: [], environments: [], connections: [], mappings: [], policyRules: [], pendingApprovals: [] };
  if (fs.existsSync(localStatePath)) {
    try { state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')); } catch (_) {}
  }
  state.connections = connectionsList;
  fs.writeFileSync(localStatePath, JSON.stringify(state, null, 2), 'utf8');
  return { connections: state.connections };
}

function simulateGuard(command = '', toolName = '') {
  // Scores through the real hook so the simulator can never diverge from what
  // core/safety/guards.json actually enforces at PreToolUse time.
  const { hardBlock, query } = riskThresholds();
  const riskScore = calculateLocalRisk({ command, toolName, targetFile: '' });

  let verdict = 'APPROVED';
  let reason = `risk ${riskScore} < warn threshold ${query} (core/safety/guards.json)`;
  if (riskScore >= hardBlock) {
    // The local fallback treats hard stops as a block that only a human clears.
    verdict = 'REQUIRE_APPROVAL';
    reason = `risk ${riskScore} >= hardBlock threshold ${hardBlock} (core/safety/guards.json)`;
  } else if (riskScore >= query) {
    verdict = 'WARN';
    reason = `risk ${riskScore} >= warn threshold ${query} (core/safety/guards.json)`;
  }

  return {
    command,
    toolName,
    verdict,
    riskScore,
    reason,
    timestamp: new Date().toISOString()
  };
}

// Real events only. Nothing is seeded here: a dashboard that ships with
// "zero secret leaks detected" is asserting a scan that never ran.
let storedAuditEvents = [];

function getDecisionsData() {
  const dashclaw = getStoredDashClawConfig();
  return {
    governed: dashclaw && dashclaw.configured,
    agentId: dashclaw ? dashclaw.agentId : 'agnostic-harness',
    baseUrl: dashclaw ? dashclaw.baseUrl : 'https://my-dashclaw.vercel.app',
    mode: dashclaw && dashclaw.active ? 'DashClaw Governed Autonomy' : 'Fail-Closed Local Hard Stops',
    recentEvents: storedAuditEvents,
    eventCount: storedAuditEvents.length
  };
}

// dashboard.html is ~142 KB and neither it nor SESSION_TOKEN changes while the
// process lives, so read and inject once instead of on every request. Lazily,
// so requiring this module still touches no disk.
let cachedPage;
function renderPage() {
  if (cachedPage === undefined) {
    cachedPage = fs.existsSync(HTML_FILE)
      ? fs.readFileSync(HTML_FILE, 'utf8')
        .replace('__DASHBOARD_TOKEN__', SESSION_TOKEN)
        .replace('__LADDER_DATA__', () => JSON.stringify({ labels: LADDER_STATE_LABELS, tiers: STATE_TIER }))
      : null;
  }
  return cachedPage;
}

function serveDashboard() {
  const server = http.createServer(async (req, res) => {
    res.setHeader(ID_HEADER, '1');
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams);

    // Helpers
    const sendJson = (data, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const readBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1048576) {
          const tooBig = new Error('Request body exceeds 1 MB limit');
          tooBig.statusCode = 413;
          req.destroy();
          reject(tooBig);
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          e.statusCode = 400;
          reject(e);
        }
      });
      req.on('error', reject);
    });

    try {
      // Every mutating route is gated here rather than per-handler, so a new
      // POST route cannot be added unprotected.
      if (req.method === 'POST' && !authorized(req)) {
        return sendJson({ error: 'Forbidden' }, 403);
      }

      if (req.method === 'GET' && pathname === '/api/overview') {
        return sendJson(getOverviewData());
      }
      if (req.method === 'GET' && pathname === '/api/errors') {
        return sendJson(getErrorsData(query));
      }
      if (req.method === 'GET' && pathname === '/api/candidate') {
        const id = query.id;
        if (!id) return sendJson({ error: 'Missing candidate id' }, 400);
        const item = getCandidate(id);
        if (!item) return sendJson({ error: 'Candidate not found' }, 404);
        return sendJson(withLadder(item));
      }
      if (req.method === 'POST' && pathname === '/api/candidate/update') {
        const body = await readBody();
        if (!body.id) return sendJson({ error: 'Missing candidate id' }, 400);
        try {
          const updated = updateCandidate(body.id, body);
          return sendJson({ success: true, item: withLadder(updated) });
        } catch (err) {
          // A move the ladder refuses is a conflict with the record's state, not a bad request.
          if (err && err.code === 'illegal_transition') return sendJson(err.toJSON(), 409);
          return sendJson({ error: err.message }, 400);
        }
      }
      if (req.method === 'POST' && pathname === '/api/candidate/delete') {
        const body = await readBody();
        if (!body.id) return sendJson({ error: 'Missing candidate id' }, 400);
        try {
          const resObj = deleteCandidate(body.id);
          return sendJson(resObj);
        } catch (err) {
          return sendJson({ error: err.message }, 400);
        }
      }
      if (req.method === 'POST' && pathname === '/api/candidate/approve') {
        // Closes the promotion loop from the human surface: writes the rule into
        // core/rules/global-rules.md (the SSOT) so the next sync distributes it.
        const body = await readBody();
        if (!body.id) return sendJson({ error: 'Missing candidate id' }, 400);
        try {
          const resObj = approveCandidate(body.id);
          // approveCandidate reports failure in the payload; a 200 there would
          // let the UI show a success toast for a rule that was never written.
          if (resObj.reason === 'illegal_transition') {
            const { current, requested, allowed, message } = resObj;
            return sendJson({ error: 'illegal_transition', current, requested, allowed, message }, 409);
          }
          if (resObj.ok === false) return sendJson({ error: resObj.reason, ...resObj }, 400);
          return sendJson(resObj);
        } catch (err) {
          return sendJson({ error: err.message }, 400);
        }
      }
      if (req.method === 'GET' && pathname === '/api/rules') {
        return sendJson(getRulesData());
      }
      if (req.method === 'GET' && pathname === '/api/skills') {
        const manifest = loadSkillsManifest();
        const config = loadSkillsConfig();
        return sendJson({ manifest, config });
      }
      if (req.method === 'POST' && pathname === '/api/skills/toggle') {
        const body = await readBody();
        const updated = toggleSkill(body.skillId, body.enabled, body.projectPath);
        return sendJson({ success: true, config: updated });
      }
      if (req.method === 'GET' && pathname === '/api/projects') {
        const projects = listAllProjectsWithRecommendations();
        return sendJson(projects);
      }
      if (req.method === 'GET' && pathname === '/api/project/recommendations') {
        const pPath = query.path;
        if (!pPath) return sendJson({ error: 'Missing path' }, 400);
        return sendJson(recommendSkillsForProject(pPath));
      }
      if (req.method === 'POST' && pathname === '/api/project/apply-recommendations') {
        const body = await readBody();
        if (!body.projectPath) return sendJson({ error: 'Missing projectPath' }, 400);
        const updated = applyProjectRecommendations(body.projectPath, body.skillOverrides);
        return sendJson({ success: true, config: updated });
      }
      if (req.method === 'GET' && pathname === '/api/audit/bloat') {
        return sendJson(auditHarnessBloat());
      }
      if (req.method === 'POST' && pathname === '/api/audit/bloat/apply') {
        const body = await readBody();
        const results = applyBloatOptimizations(body);
        return sendJson({ success: true, results });
      }
      if (req.method === 'GET' && pathname === '/api/routines') {
        return sendJson(getRoutinesData());
      }
      if (req.method === 'POST' && pathname === '/api/routines/run') {
        const body = await readBody();
        const resObj = await executeRoutine(body.routineId, { force: Boolean(body.force) });
        return sendJson(resObj);
      }
      if (req.method === 'GET' && pathname === '/api/decisions') {
        return sendJson(getDecisionsData());
      }
      if (req.method === 'GET' && pathname === '/api/dashclaw/config') {
        return sendJson(getDashClawFullConfig());
      }
      if (req.method === 'POST' && pathname === '/api/dashclaw/config') {
        const body = await readBody();
        const updated = saveDashClawConfig(body);
        return sendJson({ success: true, config: updated });
      }
      if (req.method === 'POST' && pathname === '/api/dashclaw/test-connection') {
        const body = await readBody();
        const targetUrl = (body.baseUrl || 'https://my-dashclaw.vercel.app').trim();
        const apiKey = body.apiKey || null;
        const startTime = Date.now();
        const probeResult = await checkEndpointHealth(targetUrl, apiKey, 3500);
        const latencyMs = Date.now() - startTime;
        return sendJson({
          ok: probeResult.ok || probeResult.reachable,
          reachable: probeResult.reachable,
          statusCode: probeResult.statusCode,
          latencyMs,
          url: targetUrl,
          message: probeResult.reachable ? `Reachable (${probeResult.statusCode || 200}) in ${latencyMs}ms` : 'Endpoint unreachable or connection timed out'
        });
      }
      if (req.method === 'GET' && pathname === '/api/dashclaw/policies') {
        return sendJson(getDashClawPolicies());
      }
      if (req.method === 'POST' && pathname === '/api/dashclaw/policies') {
        const body = await readBody();
        const updated = saveDashClawPolicies(body);
        return sendJson({ success: true, policies: updated });
      }
      if (req.method === 'GET' && pathname === '/api/dashclaw/connections') {
        return sendJson(getDashClawConnections());
      }
      if (req.method === 'POST' && pathname === '/api/dashclaw/connections') {
        const body = await readBody();
        const updated = saveDashClawConnections(body.connections || []);
        return sendJson({ success: true, connections: updated.connections });
      }
      if (req.method === 'POST' && pathname === '/api/dashclaw/simulate-guard') {
        const body = await readBody();
        const simulation = simulateGuard(body.command, body.toolName);
        // add to stored events
        storedAuditEvents.unshift({
          id: `evt_${Date.now()}`,
          ts: simulation.timestamp,
          type: 'GUARD_SIMULATION',
          tool: simulation.toolName || (simulation.command ? simulation.command.slice(0, 20) : 'eval'),
          verdict: simulation.verdict,
          riskScore: simulation.riskScore,
          detail: `[SIMULATION] ${simulation.reason}`
        });
        if (storedAuditEvents.length > 50) storedAuditEvents = storedAuditEvents.slice(0, 50);
        return sendJson({ success: true, simulation });
      }

      // Serve HTML
      if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
        const page = renderPage();
        if (page !== null) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(page);
        }
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f2a3a"/><text x="16" y="22" font-family="Segoe UI,Arial,sans-serif" font-size="15" font-weight="700" fill="#f2f2f2" text-anchor="middle">AG</text></svg>');
      }

      // Backward compatibility for the parity endpoint
      if (pathname === '/api/data') {
        const digestFile = path.join(STORAGE, 'distill-digest.json');
        let digest = {};
        if (fs.existsSync(digestFile)) {
          try { digest = JSON.parse(fs.readFileSync(digestFile, 'utf8')); } catch (_) {}
        }
        return sendJson(digest);
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      console.error('[Dashboard Error]', err);
      sendJson({ error: err.message }, err.statusCode || 500);
    }
  });

  const openBrowser = (url) => {
    if (!OPEN_FLAG) return;
    exec(process.platform === 'win32' ? `start ${url}` : `open ${url}`);
  };

  const firstPort = PORT;

  server.on('error', async (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('[Agnostic-Dashboard Server Error]', err);
      process.exit(1);
    }
    const url = `http://127.0.0.1:${PORT}`;
    if (await isOurDashboard(PORT)) {
      console.log(`[Agnostic-Dashboard] Command Center is already running at ${url}`);
      openBrowser(url);
      // Keep alive for the launcher (engine/setup/launch.cjs) child process monitoring
      setInterval(() => {}, 10000);
      return;
    }
    if (PORT - firstPort >= 10) {
      console.error(`[Agnostic-Dashboard] Ports ${firstPort}-${PORT} are all taken by other apps.`);
      process.exit(1);
    }
    console.log(`[Agnostic-Dashboard] Port ${PORT} belongs to another app; trying ${PORT + 1}.`);
    PORT += 1;
    server.listen(PORT, '127.0.0.1');
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`[Agnostic-Dashboard] Command Center live at ${url}`);
    openBrowser(url);
  });
}

if (require.main === module) {
  serveDashboard();
}

module.exports = { serveDashboard, isOurDashboard, getOverviewData, getErrorsData, getRulesData, getRoutinesData, getDashClawFullConfig, saveDashClawConfig, simulateGuard, getDecisionsData, authorized, SESSION_TOKEN };
