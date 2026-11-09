#!/usr/bin/env node
/**
 * engine/setup/first-run.cjs — First-Run Onboarding & Default Harness Setup.
 *
 * Runs automatically when the user uses the Agnostic Harness for the first time
 * (or manually via `npm run setup:default` / `npm run launch`).
 *
 * Actions:
 *   1. Harvester: Scans existing agent logs (~/.claude, ~/.codex, etc.) so harness starts loaded.
 *   2. Consolidator: Ingests all skills from all agent runtimes into skills/definitions/.
 *   3. Port: Captures the client the user actually drives and applies it to every
 *      other installed client. With no source client on disk, falls back to
 *      compiling the repo's own template rules (engine/sync/sync.cjs).
 *   4. Claude Code guard wiring: registers the guards this repo ships into
 *      ~/.claude/settings.json. Other clients get their hooks from the port
 *      (step 3), never from a hand-written flat hooks.json here.
 *   5. DashClaw Provisioner: Links agent identity & API key for governed autonomy.
 *   6. Persistence: Writes storage/harness-installed.json marking default installation.
 *
 * Usage:
 *   node engine/setup/first-run.cjs          # Run setup / verify default state
 *   node engine/setup/first-run.cjs --force  # Force re-installation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE = path.join(ROOT, 'storage');
const STATE_FILE = path.join(STORAGE, 'harness-installed.json');

const HOME = os.homedir();
const FORCE_FLAG = process.argv.includes('--force');

// Every client id the harness knows about, read from the registry so a number
// printed here can never drift from core/templates/targets.json.
function registryIds() {
  try {
    return require('../harness/capture.cjs').loadRegistry(HOME).map((t) => t.id);
  } catch (_) {
    return [];
  }
}

function isFirstRun(stateFile = STATE_FILE) {
  if (!fs.existsSync(stateFile)) return true;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return !state.installed;
  } catch (_) {
    return true;
  }
}

// Returns null ONLY for a file that exists but cannot be parsed. Callers must
// check existence first: an absent file is a fresh install, an unparseable one
// is a user config we must never overwrite.
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function warnMalformed(file) {
  console.warn(`  ! ${file} is not valid JSON — left untouched; fix it by hand then re-run`);
}

// The backup worth keeping is the pristine pre-install config. A second run
// would otherwise overwrite it with our own already-wired output, so an
// existing .bak is never replaced.
function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch (_) {}
  }
}

/**
 * Registers the guard hooks this repo ships into Claude Code under `home`, and
 * REPORTS (never writes) what the Codex and Gemini hook files already carry.
 *
 * Claude Code is the only client wired by hand: it hosts the guards that live in
 * engine/hooks/. Every other client's hooks arrive through `npm run port`, which
 * writes the format that client actually reads. Writing a flat
 * {"pre_tool_use": "..."} key into ~/.codex/hooks.json is what silently dropped
 * every shared guard on 2026-08-18 (Codex never read that key, then repaired the
 * file), so that path is gone.
 *
 * Always read-merge-write: an existing user hook file is preserved, never clobbered.
 * Returns a per-target report of what was installed or detected.
 */
function wireAgentHooks(home = HOME) {
  const hookCommand = (name) =>
    `node "${path.join(ROOT, 'engine', 'hooks', name).replace(/\\/g, '/')}"`;
  const report = {
    claude: { present: false, dashclawGuard: false, secretGuard: false, delegateGuard: false, graphGuard: false, advisorAgent: false, malformed: false },
    codex: { present: false, dashclawGuard: false, secretGuard: false, malformed: false },
    gemini: { present: false, dashclawGuard: false, secretGuard: false, malformed: false }
  };

  // Claude Code — PreToolUse takes {matcher, hooks[]} groups, so it can host both guards.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'); // the Claude home moves with CLAUDE_CONFIG_DIR
  const claudeSettings = path.join(claudeHome, 'settings.json');
  // No settings.json yet (a fresh machine) starts from {} so the core guards are wired on the first run.
  const claudeCfg = fs.existsSync(claudeSettings) ? readJsonSafe(claudeSettings) : {};
  if (claudeCfg === null) {
    report.claude.present = true;
    report.claude.malformed = true;
    warnMalformed(claudeSettings);
  } else if (claudeCfg) {
    report.claude.present = true;
    try {
      const cfg = claudeCfg;
      if (!cfg.hooks) cfg.hooks = {};

      // Claude Code wants PreToolUse as an array of {matcher, hooks[]} groups,
      // not the flat string Codex/Antigravity take. A lowercase key is silently
      // ignored here and breaks PowerShell ConvertFrom-Json via case collision.
      delete cfg.hooks.preToolUse; // stale invalid key from older installs
      if (!Array.isArray(cfg.hooks.PreToolUse)) cfg.hooks.PreToolUse = [];

      const matcher = 'Bash|PowerShell|Edit|Write|MultiEdit';
      const installed = [];
      for (const [script, pattern, status] of [
        ['dashclaw-guard.cjs', /dashclaw[-_](?:guard|pretool)/i, 'DashClaw guard check...'],
        ['secret-path-guard.cjs', /secret(?:-path)?-guard/i, 'Secret scan...']
      ]) {
        // Skip if this guard already gates tool calls (ours or a native one: DashClaw's own
        // dashclaw_pretool.py, or secret-guard.cjs, the name reg-hooks and the Codex/Gemini
        // detection below already accept as the secret guard).
        const guarded = cfg.hooks.PreToolUse.some(g =>
          (g.hooks || []).some(h => pattern.test(h.command || '')));
        if (!guarded) {
          cfg.hooks.PreToolUse.push({
            matcher,
            hooks: [{ type: 'command', command: hookCommand(script), timeout: 10, statusMessage: status }]
          });
          installed.push(script);
        }
      }
      report.claude.dashclawGuard = true;
      report.claude.secretGuard = true;

      // fable-delegate-guard also needs the two session events, which take
      // {hooks:[...]} groups with no matcher key.
      const delegateCommand = hookCommand('fable-delegate-guard.cjs');
      const hasDelegate = (groups) =>
        (groups || []).some(g => (g.hooks || []).some(h => /fable-delegate-guard/i.test(h.command || '')));
      if (!hasDelegate(cfg.hooks.PreToolUse)) {
        cfg.hooks.PreToolUse.push({
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
          hooks: [{ type: 'command', command: delegateCommand, timeout: 10, statusMessage: 'Delegate-first check...' }]
        });
        installed.push('fable-delegate-guard.cjs');
      }
      // UserPromptSubmit runs ONE process, prompt-dispatch.cjs, whose CHAIN already carries the
      // delegate guard; a second spawn there is what timed out on every prompt (2026-09-19).
      const hasDispatch = (groups) =>
        (groups || []).some(g => (g.hooks || []).some(h => /prompt-dispatch/i.test(h.command || '')));
      if (!Array.isArray(cfg.hooks.UserPromptSubmit)) cfg.hooks.UserPromptSubmit = [];
      if (!hasDispatch(cfg.hooks.UserPromptSubmit) && !hasDelegate(cfg.hooks.UserPromptSubmit)) {
        cfg.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: hookCommand('prompt-dispatch.cjs'), timeout: 30, statusMessage: 'Prompt hooks...' }] });
        installed.push('prompt-dispatch.cjs');
      }
      for (const event of ['SessionStart']) {
        if (!Array.isArray(cfg.hooks[event])) cfg.hooks[event] = [];
        if (!hasDelegate(cfg.hooks[event])) {
          cfg.hooks[event].push({ hooks: [{ type: 'command', command: delegateCommand, timeout: 10 }] });
        }
      }
      report.claude.delegateGuard = true;

      // opening-move briefs a new session (startup, /clear, compact; a resume already
      // had its brief). Its UserPromptSubmit half runs inside prompt-dispatch's CHAIN.
      const hasOpening = (groups) =>
        (groups || []).some(g => (g.hooks || []).some(h => /opening-move/i.test(h.command || '')));
      if (!hasOpening(cfg.hooks.SessionStart)) {
        cfg.hooks.SessionStart.push({ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: hookCommand('opening-move.cjs'), timeout: 5 }] });
        installed.push('opening-move.cjs');
      }

      // capability-graph-guard gates the delegation edges themselves, and needs
      // SubagentStart to learn each subagent's model (no other event carries it).
      const graphCommand = hookCommand('capability-graph-guard.cjs');
      const hasGraph = (groups) =>
        (groups || []).some(g => (g.hooks || []).some(h => /capability-graph-guard/i.test(h.command || '')));
      if (!hasGraph(cfg.hooks.PreToolUse)) {
        cfg.hooks.PreToolUse.push({
          matcher: 'Agent|Task|Workflow',
          hooks: [{ type: 'command', command: graphCommand, timeout: 10, statusMessage: 'Capability graph check...' }]
        });
        installed.push('capability-graph-guard.cjs');
      }
      for (const event of ['SubagentStart', 'SubagentStop']) {
        if (!Array.isArray(cfg.hooks[event])) cfg.hooks[event] = [];
        if (!hasGraph(cfg.hooks[event])) {
          cfg.hooks[event].push({ hooks: [{ type: 'command', command: graphCommand, timeout: 10 }] });
        }
      }
      report.claude.graphGuard = true;

      // The advisor agent is the only upward edge in the graph. An existing one
      // is the operator's, never ours to overwrite.
      const advisorDest = path.join(claudeHome, 'agents', 'advisor.md');
      if (fs.existsSync(advisorDest)) {
        report.claude.advisorAgent = 'kept';
      } else {
        fs.mkdirSync(path.dirname(advisorDest), { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'agents', 'advisor.md'), advisorDest); // agents/ is the canonical roster (linked into ~/.claude/agents by engine/setup/link.cjs)
        report.claude.advisorAgent = 'installed';
      }

      if (fs.existsSync(claudeSettings)) backup(claudeSettings); else fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
      fs.writeFileSync(claudeSettings, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      console.log(`  ✓ Claude Code hooks in ~/.claude/settings.json (dashclaw-guard + secret-guard + fable-delegate-guard + capability-graph-guard${installed.length ? `; added ${installed.join(', ')}` : '; already present'}; advisor agent ${report.claude.advisorAgent})`);
    } catch (err) {
      report.claude.dashclawGuard = false;
      report.claude.secretGuard = false;
      report.claude.delegateGuard = false;
      report.claude.graphGuard = false;
      console.warn(`  ! Could not wire Claude Code hooks in ${claudeSettings}: ${err.message}`);
    }
  }

  // Codex CLI and Gemini/Antigravity: detect only. Their hook files are written
  // by `npm run port` in the lifecycle format those clients read; this function
  // reads them so the report says what is actually wired, and touches nothing.
  const readOnlyTargets = [
    { key: 'codex', dir: path.join(home, '.codex'), file: path.join(home, '.codex', 'hooks.json'), label: '~/.codex/hooks.json' },
    { key: 'gemini', dir: path.join(home, '.gemini', 'config'), file: path.join(home, '.gemini', 'config', 'hooks.json'), label: '~/.gemini/config/hooks.json' }
  ];

  for (const target of readOnlyTargets) {
    if (!fs.existsSync(target.dir)) continue;
    report[target.key].present = true;
    if (!fs.existsSync(target.file)) {
      console.log(`  - ${target.label} absent; hooks for this client come from \`npm run port\``);
      continue;
    }
    const cfg = readJsonSafe(target.file);
    if (cfg === null) {
      report[target.key].malformed = true;
      warnMalformed(target.file);
      continue;
    }
    const text = JSON.stringify(cfg);
    report[target.key].dashclawGuard = /dashclaw-guard/i.test(text);
    report[target.key].secretGuard = /secret-guard/i.test(text);
    const wired = [report[target.key].dashclawGuard && 'dashclaw-guard', report[target.key].secretGuard && 'secret-guard'].filter(Boolean).join(' + ') || 'no agnostic guard';
    console.log(`  - ${target.label}: ${wired} (read only; \`npm run port\` owns this file)`);
  }

  return report;
}

async function runFirstRunSetup() {
  console.log('==================================================');
  console.log('   AGNOSTIC AI HARNESS — FIRST-RUN SETUP & WIRING');
  console.log('==================================================\n');

  const steps = [
    {
      title: '[1/5] Harvesting past errors, corrections, and meditation candidates...',
      run: async () => {
        const { runHarvest } = require('../harvest/harvest.cjs');
        return runHarvest();
      }
    },
    {
      title: '[2/5] Ingesting and consolidating all agent skills...',
      run: async () => {
        const { consolidateSkills } = require('../skills/consolidate.cjs');
        return consolidateSkills();
      }
    },
    {
      title: `[3/5] Porting your harness into ${registryIds().length} client targets...`,
      run: async () => {
        const { capture, detectSource } = require('../harness/capture.cjs');
        const { apply } = require('../harness/apply.cjs');
        const source = detectSource(HOME);
        if (!source) {
          console.log('  - no source client on disk (~/.claude/CLAUDE.md or ~/.codex/AGENTS.md); compiling the repo template rules instead');
          const { run } = require('../sync/sync.cjs');
          return run();
        }
        try {
          const { bundle, warnings } = capture({ home: HOME });
          for (const warning of warnings) console.log(`  ! ${warning}`);
          return apply({ bundle, home: HOME });
        } catch (err) {
          // A port that cannot run must still leave the user with rules files.
          console.warn(`  ! Port from ${source} failed (${err.message}); compiling the repo template rules instead`);
          const { run } = require('../sync/sync.cjs');
          return run();
        }
      }
    },
    {
      title: '[4/5] Wiring Claude Code guards and DashClaw governance...',
      run: async () => {
        const { autoConfigureDashClaw } = require('../hooks/dashclaw-setup.cjs');
        const dashclawResult = await autoConfigureDashClaw();

        const hookReport = wireAgentHooks();
        const wired = Object.entries(hookReport)
          .filter(([, r]) => r.present)
          .map(([name, r]) => `${name}(${[r.dashclawGuard && 'dashclaw-guard', r.secretGuard && 'secret-guard', r.delegateGuard && 'fable-delegate-guard', r.graphGuard && 'capability-graph-guard'].filter(Boolean).join('+') || 'none'})`);
        console.log(`  ✓ Guard hooks: ${wired.length ? wired.join(', ') : 'none detected'} (claude wired here; the rest are written by \`npm run port\`)`);

        return dashclawResult;
      }
    },
    {
      title: '[5/5] Finalizing default harness configuration & state...',
      run: async () => {
        if (!fs.existsSync(STORAGE)) fs.mkdirSync(STORAGE, { recursive: true });
        const installState = {
          installed: true,
          installedAt: new Date().toISOString(),
          root: ROOT,
          version: require(path.join(ROOT, 'package.json')).version,
          defaultFor: registryIds()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(installState, null, 2), 'utf8');
        console.log(`  ✓ Default harness state persisted: ${STATE_FILE}`);
        return installState;
      }
    }
  ];

  for (const step of steps) {
    console.log(step.title);
    try {
      await step.run();
    } catch (err) {
      console.error(`  ✗ Error in step: ${err.message}`);
    }
    console.log('');
  }

  const ids = registryIds();
  console.log('==================================================');
  console.log('  ✓ Agnostic AI Harness is installed');
  console.log(`    ${ids.length} client targets known: ${ids.join(', ')}`);
  console.log('    Re-run any time with: npm run port');
  console.log('==================================================\n');
}

if (require.main === module) {
  if (!FORCE_FLAG && !isFirstRun()) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log(`✓ Agnostic AI Harness already installed (${state.installedAt || 'unknown date'}, v${state.version || '?'}).`);
    console.log('  Nothing to do. Re-run with --force to reinstall.');
  } else {
    runFirstRunSetup();
  }
}

module.exports = { isFirstRun, runFirstRunSetup, wireAgentHooks };
