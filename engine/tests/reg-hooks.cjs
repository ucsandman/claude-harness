#!/usr/bin/env node
/**
 * engine/tests/reg-hooks.cjs — Regression tests for the engine security hooks.
 *
 * Covers the fail-open / bypass defects in dashclaw-guard, secret-guard,
 * dashclaw-setup and first-run. Policy comes from core/safety/guards.json.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

// Isolate HOME before any hook module is loaded (they cache os.homedir() at require time).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-home-'));
process.env.USERPROFILE = TMP_HOME;
process.env.HOME = TMP_HOME;

const ROOT = path.resolve(__dirname, '..', '..');
const GUARDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'safety', 'guards.json'), 'utf8')).guards;
const HARD_BLOCK = GUARDS.dashclaw.hardBlockRiskThreshold;
const DC_CONFIG_STORAGE = path.join(ROOT, 'storage', 'dashclaw-config.json');

const guard = require('../hooks/dashclaw-guard.cjs');
const secretGuard = require('../hooks/secret-path-guard.cjs');
const dashclawSetup = require('../hooks/dashclaw-setup.cjs');
const fableGuard = require('../hooks/fable-delegate-guard.cjs');
const graphGuard = require('../hooks/capability-graph-guard.cjs');
const firstRun = require('../setup/first-run.cjs');

console.log('=== Running Engine Hook Security Regression Tests ===\n');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function denied(result) {
  return result.allowed === false || result.decision === 'deny' || result.permissionDecision === 'deny';
}

function shellPayload(command) {
  return { tool: 'bash', args: { command } };
}

const FAKE_CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:65535',
  apiKey: null,
  agentId: 'reg-test',
  agentName: 'Reg Test'
};

async function run() {
  // --- 1. Risk scoring uses guards.json patterns, not hardcoded includes() ---
  const HIGH_RISK_COMMANDS = [
    'git push origin main --force',
    'git push -f origin main',
    'rm -rf ~/Projects',
    'git reset --hard HEAD~5',
    'npm publish'
  ];
  for (const cmd of HIGH_RISK_COMMANDS) {
    await test(`Risk: '${cmd}' scores >= ${HARD_BLOCK}`, () => {
      const risk = guard.calculateLocalRisk({ command: cmd, targetFile: null });
      assert(risk >= HARD_BLOCK, `expected >= ${HARD_BLOCK}, got ${risk}`);
    });
  }

  await test('Risk: benign command stays low', () => {
    const risk = guard.calculateLocalRisk({ command: 'git status', targetFile: null });
    assert(risk < GUARDS.dashclaw.defaultRiskThreshold, `expected low risk, got ${risk}`);
  });

  // --- 2. Fail CLOSED on remote failure / exception ---
  await test('FailClosed: high risk + remote throws => BLOCK', async () => {
    process.env.ALLOW_HIGH_RISK = '1';
    const result = await guard.handleGuard(shellPayload('git push origin main --force'), {
      getDashClawConfig: () => FAKE_CONFIG,
      queryDashClawGuard: () => { throw new Error('remote exploded'); }
    });
    delete process.env.ALLOW_HIGH_RISK;
    assert(denied(result), `expected denial, got ${JSON.stringify(result)}`);
  });

  await test('FailClosed: high risk + remote resolves null (timeout) => BLOCK', async () => {
    const result = await guard.handleGuard(shellPayload('rm -rf ~/Projects'), {
      getDashClawConfig: () => FAKE_CONFIG,
      queryDashClawGuard: async () => null
    });
    assert(denied(result), `expected denial, got ${JSON.stringify(result)}`);
  });

  await test('FailClosed: ALLOW_HIGH_RISK env no longer bypasses the hard block', async () => {
    process.env.ALLOW_HIGH_RISK = '1';
    const result = await guard.handleGuard(shellPayload('git push -f origin main'), {
      getDashClawConfig: () => ({ ...FAKE_CONFIG, enabled: false })
    });
    delete process.env.ALLOW_HIGH_RISK;
    assert(denied(result), `expected denial, got ${JSON.stringify(result)}`);
  });

  await test('FailClosed: low risk + remote null still allowed', async () => {
    const result = await guard.handleGuard(shellPayload('git status'), {
      getDashClawConfig: () => FAKE_CONFIG,
      queryDashClawGuard: async () => null
    });
    assert(!denied(result), `expected approval, got ${JSON.stringify(result)}`);
  });

  // --- 3. secret-guard scans secret PATHS inside command strings ---
  const SECRET_COMMANDS = [
    'cat ~/.secrets.env',
    'type ~/.ssh/id_rsa',
    'cat .env',
    'Get-Content C:/Users/me/.aws/credentials',
    // Bypasses found by adversarial review (git rev-spec, glob, direnv, bare .aws):
    'git show HEAD:.env',
    'git show :.env',
    'git cat-file -p HEAD:.env',
    'cat *.env',
    'cat .envrc',
    'cat .aws/credentials',
    'cat .env | head -5',
    'sed -n 1p .env'
  ];
  for (const cmd of SECRET_COMMANDS) {
    await test(`SecretGuard: blocks '${cmd}'`, () => {
      const result = secretGuard.handlePayload(shellPayload(cmd));
      assert(denied(result), `expected denial, got ${JSON.stringify(result)}`);
    });
  }

  // Must NOT false-positive on benign commands that merely contain "env".
  for (const cmd of ['cat README.md', 'ls -la', 'cat .environment', 'npm run env-check', 'git commit -m env']) {
    await test(`SecretGuard: allows benign '${cmd}'`, () => {
      const result = secretGuard.handlePayload(shellPayload(cmd));
      assert(!denied(result), `expected approval, got ${JSON.stringify(result)}`);
    });
  }

  // --- 4. dashclaw-setup does not adopt a bare healthy localhost:3000 ---
  await test('Setup: does NOT adopt a healthy 127.0.0.1 dev server when adoptLocalhostPortsAllowed=false', async () => {
    assert.strictEqual(GUARDS.dashclaw.adoptLocalhostPortsAllowed, false, 'guards.json must forbid localhost adoption');
    const backup = fs.existsSync(DC_CONFIG_STORAGE) ? fs.readFileSync(DC_CONFIG_STORAGE, 'utf8') : null;
    const savedEnv = { url: process.env.DASHCLAW_BASE_URL, key: process.env.DASHCLAW_API_KEY };
    delete process.env.DASHCLAW_BASE_URL;
    delete process.env.DASHCLAW_API_KEY;

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    // Port 0: a listen() failure is an 'error' EVENT, not a rejection, so a fixed
    // port that some other dev server already holds would crash the whole suite.
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const config = await dashclawSetup.autoConfigureDashClaw();
      assert.strictEqual(config.configured, false, `must not configure from a bare local probe on port ${server.address().port}: ${JSON.stringify(config)}`);
      assert.strictEqual(config.active, false, 'must not activate from a bare local probe');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (backup !== null) fs.writeFileSync(DC_CONFIG_STORAGE, backup, 'utf8');
      else if (fs.existsSync(DC_CONFIG_STORAGE)) fs.unlinkSync(DC_CONFIG_STORAGE);
      if (savedEnv.url) process.env.DASHCLAW_BASE_URL = savedEnv.url;
      if (savedEnv.key) process.env.DASHCLAW_API_KEY = savedEnv.key;
    }
  });

  // --- 5. first-run merges hook files instead of clobbering them ---
  await test('FirstRun: merges existing ~/.codex/hooks.json instead of clobbering', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-codex-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const hooksFile = path.join(home, '.codex', 'hooks.json');
    fs.writeFileSync(hooksFile, JSON.stringify({ pre_tool_use: 'node "C:/mine.js"', custom: 'keep-me' }, null, 2), 'utf8');

    firstRun.wireAgentHooks(home);

    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.strictEqual(after.custom, 'keep-me', 'existing user key must survive');
    assert.strictEqual(after.pre_tool_use, 'node "C:/mine.js"', 'existing user hook must not be overwritten');
  });

  // first-run no longer writes a Codex or Gemini hook file at all: it writes the
  // flat key those clients never read (the 2026-08-18 clobbering), so their hooks
  // now come from `npm run port` in the lifecycle format they do read. What
  // first-run still owes is a truthful report of what is already wired there.
  await test('FirstRun: never writes ~/.codex/hooks.json; the port owns that file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-codex2-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const hooksFile = path.join(home, '.codex', 'hooks.json');
    const original = JSON.stringify({ custom: 'keep-me' }, null, 2);
    fs.writeFileSync(hooksFile, original, 'utf8');

    const report = firstRun.wireAgentHooks(home).codex;

    assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), original, 'the hook file must be left byte-identical');
    assert.strictEqual(report.present, true, 'an installed Codex must still be reported present');
    assert.strictEqual(report.dashclawGuard, false, 'no guard is in that file, so none may be claimed');
  });

  await test('FirstRun: never writes ~/.gemini/config/hooks.json; the port owns that file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-gemini-'));
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    const hooksFile = path.join(home, '.gemini', 'config', 'hooks.json');
    const original = JSON.stringify({ custom: 'keep-me' }, null, 2);
    fs.writeFileSync(hooksFile, original, 'utf8');

    const report = firstRun.wireAgentHooks(home).gemini;

    assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), original, 'the hook file must be left byte-identical');
    assert.strictEqual(report.present, true, 'an installed Gemini must still be reported present');
    assert.strictEqual(report.dashclawGuard, false, 'no guard is in that file, so none may be claimed');
  });

  // --- 6. secret-guard is actually wired into Claude Code ---
  await test('FirstRun: wires secret-guard AND dashclaw-guard into Claude PreToolUse', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: {} }, null, 2), 'utf8');

    const report = firstRun.wireAgentHooks(home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(after.model, 'opus', 'existing settings must survive');
    const commands = (after.hooks.PreToolUse || []).flatMap(g => (g.hooks || []).map(h => h.command || ''));
    assert(commands.some(c => /dashclaw-guard/.test(c)), `dashclaw-guard not wired: ${JSON.stringify(commands)}`);
    assert(commands.some(c => /secret-(path-)?guard/.test(c)), `secret-guard not wired: ${JSON.stringify(commands)}`);
    assert(report.claude.secretGuard === true, 'report must state secret-guard was installed for claude');
  });

  // --- 6b. a malformed settings file is never replaced by a hooks-only file ---
  await test('FirstRun: leaves a malformed ~/.claude/settings.json byte-identical', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-bad-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    const malformed = '{"permissions":{"allow":["Bash(git:*)"]},"model":"opus",}';
    fs.writeFileSync(settings, malformed, 'utf8');

    const logs = [];
    const realLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let report;
    try {
      report = firstRun.wireAgentHooks(home);
    } finally {
      console.log = realLog;
    }

    assert.strictEqual(fs.readFileSync(settings, 'utf8'), malformed, 'malformed settings must be left byte-identical');
    assert.strictEqual(report.claude.malformed, true, 'report must flag the target as malformed');
    assert.strictEqual(report.claude.dashclawGuard, false, 'nothing may be reported as wired');
    assert(!logs.some(l => l.includes('\u2713') && /settings\.json/.test(l)), `no success line may be printed: ${JSON.stringify(logs)}`);
  });

  await test('FirstRun: leaves a malformed ~/.codex/hooks.json byte-identical', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-codex-bad-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const hooksFile = path.join(home, '.codex', 'hooks.json');
    const malformed = '{"pre_tool_use":"node \\"C:/mine.js\\"",}';
    fs.writeFileSync(hooksFile, malformed, 'utf8');

    const report = firstRun.wireAgentHooks(home);

    assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), malformed, 'malformed hooks file must be left byte-identical');
    assert.strictEqual(report.codex.malformed, true, 'report must flag the target as malformed');
    assert.strictEqual(report.codex.dashclawGuard, false, 'nothing may be reported as wired');
  });

  // --- 7. first-run actually detects a prior run ---
  await test('FirstRun: isFirstRun() is false once a prior install is recorded', () => {
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-state-')), 'harness-installed.json');
    assert.strictEqual(firstRun.isFirstRun(stateFile), true, 'missing state file means first run');
    fs.writeFileSync(stateFile, JSON.stringify({ installed: true }), 'utf8');
    assert.strictEqual(firstRun.isFirstRun(stateFile), false, 'recorded install must suppress re-setup');
  });

  // --- 8. fable-delegate-guard: a Fable main loop must delegate the hands-on work ---
  const FABLE = 'claude-fable-5-1';

  // Each case gets an isolated home. tmpdir is redirected inside that home so
  // the real os.tmpdir() (which contains the fake home) cannot allow everything.
  function fableEnv() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-fable-'));
    return {
      home,
      opts: {
        home,
        stateDir: path.join(home, 'state'),
        logPath: path.join(home, 'guard.jsonl'),
        tmpdir: path.join(home, 'tmp'),
        env: {}
      }
    };
  }

  function logKinds(opts) {
    if (!fs.existsSync(opts.logPath)) return [];
    return fs.readFileSync(opts.logPath, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l).kind);
  }

  const body = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

  // 2026-09-06: the guard no longer denies anything. Its log showed 714 overrides, 266 shell denials
  // (npm test, a heredoc commit message, a read-only grep) and edit denials retried five to seven times
  // on the same file; a cap at edit 21 left a half-edited file. It briefs and logs now.
  await test('FableGuard: a large Write into the repo is allowed and logged as large-edit', () => {
    const { opts } = fableEnv();
    const payload = {
      hook_event_name: 'PreToolUse', session_id: 's-edit', prompt_id: 'p1', cwd: 'C:/repo',
      tool_name: 'Write', tool_input: { file_path: 'C:/repo/x.py', content: body(400) }
    };
    const result = fableGuard.decide(payload, { ...opts, model: FABLE });
    assert.strictEqual(result.action, 'allow', JSON.stringify(result));
    assert.strictEqual(result.kind, 'large-edit');
    assert.deepStrictEqual(logKinds(opts), ['large-edit'], 'the large edit must be logged');
    assert.strictEqual(fableGuard.main(payload, { ...opts, model: FABLE }), '', 'PreToolUse must emit nothing (no deny)');
  });

  await test('FableGuard: small direct edits have no per-prompt budget and are not logged', () => {
    const { opts } = fableEnv();
    const small = {
      session_id: 's-budget', prompt_id: 'p1', cwd: 'C:/repo',
      tool_name: 'Write', tool_input: { file_path: 'C:/repo/x.py', content: body(10) }
    };
    for (let i = 1; i <= 25; i++) {
      const r = fableGuard.decide(small, { ...opts, model: FABLE });
      assert.strictEqual(r.action, 'allow', `edit ${i}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.kind, 'small-edit', `edit ${i}: ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual(logKinds(opts), [], 'small edits are not log-worthy');
  });

  await test('FableGuard: "hands-on" in a prompt is an ordinary prompt now (nothing to suspend)', () => {
    const { opts } = fableEnv();
    const out = fableGuard.main({ hook_event_name: 'UserPromptSubmit', session_id: 's-hands', cwd: 'C:/repo', prompt: 'fix everything yourself line by line' }, { ...opts, model: FABLE });
    assert(JSON.parse(out).hookSpecificOutput.additionalContext.includes('Token economics'), `first prompt gets the briefing: ${out}`);
    assert.deepStrictEqual(logKinds(opts), [], 'no hands-on event is logged');
  });

  await test('FableGuard: writes under the scratchpad and ~/.claude are allowed', () => {
    const { home, opts } = fableEnv();
    const scratch = path.join(home, 'scratch');
    const inScratch = fableGuard.decide({
      session_id: 's-ok', cwd: 'C:/repo', scratchpad_dir: scratch,
      tool_name: 'Write', tool_input: { file_path: path.join(scratch, 'note.md') }
    }, { ...opts, model: FABLE });
    assert.strictEqual(inScratch.kind, 'allowed-path', JSON.stringify(inScratch));

    const inClaude = fableGuard.decide({
      session_id: 's-ok', cwd: 'C:/repo',
      tool_name: 'Edit', tool_input: { file_path: path.join(home, '.claude', 'projects', 'p', 'memory', 'a.md') }
    }, { ...opts, model: FABLE });
    assert.strictEqual(inClaude.kind, 'allowed-path', JSON.stringify(inClaude));
  });

  await test('FableGuard: a subagent (agent_id present) may write anywhere', () => {
    const { opts } = fableEnv();
    const result = fableGuard.decide({
      session_id: 's-sub', agent_id: 'agent_123', agent_type: 'sonnet-implementer', cwd: 'C:/repo',
      tool_name: 'Write', tool_input: { file_path: 'C:/repo/x.py', content: body(200) }
    }, { ...opts, model: FABLE });
    assert.strictEqual(result.kind, 'subagent', JSON.stringify(result));
    assert.strictEqual(result.action, 'allow');
  });

  await test('FableGuard: an Opus main loop is untouched', () => {
    const { home, opts } = fableEnv();
    const transcript = path.join(home, 'opus.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }) + '\n', 'utf8');
    const result = fableGuard.decide({
      session_id: 's-opus', cwd: 'C:/repo', transcript_path: transcript,
      tool_name: 'Write', tool_input: { file_path: 'C:/repo/x.py', content: body(200) }
    }, opts);
    assert.strictEqual(result.kind, 'not-fable', JSON.stringify(result));
    assert.strictEqual(result.model, 'claude-opus-5');
  });

  const SHELL_CASES = [
    ['git status && python -m pytest tests/ -q', 'allowed-shell'],
    ['git commit -m x', 'allowed-shell'],
    ["python - <<'EOF'", 'shell-write'],
    ['echo hi > C:/repo/out.txt', 'shell-write'],
    ['npm install left-pad', 'allowed-shell'],
    ['python -c "open(\'a\',\'w\').write(1)"', 'shell-write'],
    ['ruff check . 2>&1', 'allowed-shell'],
    ['git show --no-patch HEAD', 'allowed-shell'],
    ['Set-Content -Path a -Value b', 'shell-write']
  ];
  for (const [command, kind] of SHELL_CASES) {
    await test(`FableGuard: shell '${command}' => ${kind} (always allowed)`, () => {
      const { opts } = fableEnv();
      const result = fableGuard.decide({
        session_id: 's-shell', cwd: 'C:/repo',
        tool_name: /Set-Content/.test(command) ? 'PowerShell' : 'Bash',
        tool_input: { command }
      }, { ...opts, model: FABLE });
      assert.strictEqual(result.action, 'allow', JSON.stringify(result));
      assert.strictEqual(result.kind, kind, JSON.stringify(result));
      assert.deepStrictEqual(logKinds(opts), kind === 'shell-write' ? ['shell-write'] : [], 'only code-writing shell is logged');
    });
  }

  await test('FableGuard: redirection into the tmpdir is allowed', () => {
    const { opts } = fableEnv();
    const result = fableGuard.decide({
      session_id: 's-tmp', cwd: 'C:/repo', tool_name: 'Bash',
      tool_input: { command: `echo hi > ${opts.tmpdir.replace(/\\/g, '/')}/out.txt` }
    }, { ...opts, model: FABLE });
    assert.strictEqual(result.kind, 'allowed-shell', JSON.stringify(result));
  });

  await test('FableGuard: a leftover "# FABLE_OK:" marker changes nothing (allowed, logged as shell-write)', () => {
    const { opts } = fableEnv();
    const result = fableGuard.decide({
      session_id: 's-ovr', cwd: 'C:/repo', tool_name: 'Bash',
      tool_input: { command: 'rm -rf build # FABLE_OK: stale artefacts' }
    }, { ...opts, model: FABLE });
    assert.strictEqual(result.kind, 'shell-write', JSON.stringify(result));
    assert.strictEqual(result.action, 'allow');
    assert.deepStrictEqual(logKinds(opts), ['shell-write']);
  });

  await test('FableGuard: FABLE_DELEGATE_GUARD=off disables the guard', () => {
    const { opts } = fableEnv();
    const result = fableGuard.decide({
      session_id: 's-off', cwd: 'C:/repo', tool_name: 'Write',
      tool_input: { file_path: 'C:/repo/x.py', content: body(200) }
    }, { ...opts, model: FABLE, env: { FABLE_DELEGATE_GUARD: 'off' } });
    assert.strictEqual(result.kind, 'disabled', JSON.stringify(result));
    assert.strictEqual(result.action, 'allow');
  });

  await test('FableGuard: sessionModel reads the transcript tail, caches it, falls back to settings', () => {
    const { home, opts } = fableEnv();
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { model: FABLE } })
    ].join('\n') + '\n', 'utf8');

    assert.strictEqual(fableGuard.sessionModel({ session_id: 'sm1', transcript_path: transcript }, opts), FABLE);
    assert.strictEqual(fs.readFileSync(path.join(opts.stateDir, 'sm1.model'), 'utf8'), FABLE, 'model must be cached per session');

    fs.unlinkSync(transcript);
    assert.strictEqual(fableGuard.sessionModel({ session_id: 'sm1', transcript_path: transcript }, opts), FABLE, 'cache must survive a missing transcript');

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }), 'utf8');
    assert.strictEqual(fableGuard.sessionModel({ session_id: 'sm2' }, opts), 'claude-opus-5', 'settings.json is the last fallback');
    assert.strictEqual(fableGuard.sessionModel({ session_id: 'sm3' }, { ...opts, home: path.join(home, 'nope') }), null);
  });

  await test('FableGuard: the delegate-first briefing is injected once per session', () => {
    const { opts } = fableEnv();
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'up1', cwd: 'C:/repo', prompt: 'go' };
    const first = fableGuard.main(payload, { ...opts, model: FABLE });
    assert(first, 'first UserPromptSubmit must inject');
    const parsed = JSON.parse(first);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert(parsed.hookSpecificOutput.additionalContext.includes('Token economics'), first);
    assert.strictEqual(fableGuard.main(payload, { ...opts, model: FABLE }), '', 'second call must stay silent');
    assert(fableGuard.injectionText().includes('Token economics'));
  });

  await test('FirstRun: wires fable-delegate-guard into PreToolUse and SessionStart, and the dispatcher into UserPromptSubmit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-fable-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }, null, 2), 'utf8');

    firstRun.wireAgentHooks(home);
    const report = firstRun.wireAgentHooks(home); // idempotent

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const count = (event, pattern = /fable-delegate-guard/) => (after.hooks[event] || [])
      .flatMap(g => (g.hooks || []).map(h => h.command || ''))
      .filter(c => pattern.test(c)).length;
    for (const event of ['PreToolUse', 'SessionStart']) {
      assert.strictEqual(count(event), 1, `${event} must hold exactly one delegate-guard entry`);
    }
    // Since 2026-09-19 UserPromptSubmit runs ONE process, prompt-dispatch.cjs, whose CHAIN
    // carries the delegate guard; a second spawn there timed out on every prompt.
    assert.strictEqual(count('UserPromptSubmit', /prompt-dispatch/), 1, 'UserPromptSubmit must hold exactly one dispatcher entry');
    assert.strictEqual(count('UserPromptSubmit'), 0, 'UserPromptSubmit must not spawn the delegate guard a second time');
    const pre = after.hooks.PreToolUse.find(g => (g.hooks || []).some(h => /fable-delegate-guard/.test(h.command || '')));
    assert.strictEqual(pre.matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell');
    assert.strictEqual(report.claude.delegateGuard, true, 'report must state the delegate guard was installed');
  });

  // --- 8b. opening-move: the SessionStart brief once, its prompt half in the dispatcher CHAIN ---

  await test('OpeningMove: rides second in the prompt-dispatch CHAIN, right after wakeup-guard, via exportedMain', () => {
    const dispatch = require('../hooks/prompt-dispatch.cjs');
    const names = dispatch.CHAIN.map(e => e.file);
    assert.strictEqual(names[0], 'wakeup-guard.cjs', names.join(', '));
    assert.strictEqual(names[1], 'opening-move.cjs', names.join(', '));
    assert.strictEqual(names.filter(n => n === 'opening-move.cjs').length, 1, 'opening-move must appear once');
    assert.strictEqual(dispatch.CHAIN[1].exportedMain, true, 'opening-move must run through its exported main');
    const om = require('../hooks/opening-move.cjs');
    for (const k of ['main', 'rank', 'HARD_STOP_RE', 'STATE_DIR']) assert.ok(om[k], `opening-move must export ${k}`);
    assert.strictEqual(om.main({ hook_event_name: 'UserPromptSubmit', session_id: 'om1', cwd: ROOT, prompt: 'go', transcript_path: 'x.jsonl' }, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), '', 'a non-cli entrypoint must stay silent');
  });

  await test('FirstRun: wires opening-move into SessionStart exactly once (startup|clear|compact, timeout 10)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-opening-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }, null, 2), 'utf8');

    firstRun.wireAgentHooks(home);
    firstRun.wireAgentHooks(home); // idempotent

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const groups = (event) => (after.hooks[event] || []).filter(g => (g.hooks || []).some(h => /opening-move/.test(h.command || '')));
    assert.strictEqual(groups('SessionStart').length, 1, 'SessionStart must hold exactly one opening-move group');
    const g = groups('SessionStart')[0];
    assert.strictEqual(g.matcher, 'startup|clear|compact');
    assert.strictEqual(g.hooks.length, 1);
    assert.strictEqual(g.hooks[0].timeout, 10);
    assert.ok(/engine\/hooks\/opening-move\.cjs"$/.test(g.hooks[0].command), g.hooks[0].command);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop']) assert.strictEqual(groups(event).length, 0, `${event} must not spawn opening-move (the CHAIN runs it)`);
  });

  await test('FirstRun: wires turn-close into Stop exactly once (timeout 10, synchronous) and drops forced-verify-stop-gate', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-turnclose-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    const dead = { type: 'command', command: 'node "C:/Users/x/.claude/hooks/forced-verify-stop-gate.cjs"', timeout: 15 };
    const sound = { type: 'command', command: 'powershell -NoProfile -Command "beep"', async: true };
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [sound, dead] }, { hooks: [dead] }] } }, null, 2), 'utf8');

    firstRun.wireAgentHooks(home);
    firstRun.wireAgentHooks(home); // idempotent

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const cmds = (event) => (after.hooks[event] || []).flatMap(g => (g.hooks || []).map(h => h.command || ''));
    assert.strictEqual(cmds('Stop').filter(c => /turn-close/.test(c)).length, 1, 'Stop must hold exactly one turn-close command');
    assert.strictEqual(cmds('Stop').filter(c => /forced-verify-stop-gate/.test(c)).length, 0, 'forced-verify-stop-gate must be gone from Stop');
    const g = after.hooks.Stop.find(x => (x.hooks || []).some(h => /turn-close/.test(h.command || '')));
    assert.strictEqual(g.hooks.length, 1);
    assert.strictEqual(g.hooks[0].timeout, 10);
    assert.ok(!g.hooks[0].async, 'turn-close must run synchronously: enforce mode returns a decision');
    assert.ok(/engine\/hooks\/turn-close\.cjs"$/.test(g.hooks[0].command), g.hooks[0].command);
    assert.deepStrictEqual(after.hooks.Stop[0].hooks, [sound], 'a group that also held another hook keeps it');
    assert.strictEqual(after.hooks.Stop.length, 2, 'the group left empty by the drop goes: ' + JSON.stringify(after.hooks.Stop));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'SessionStart']) assert.strictEqual(cmds(event).filter(c => /turn-close/.test(c)).length, 0, `${event} must not spawn turn-close`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'engine', 'hooks', 'forced-verify-stop-gate.cjs')), 'the dead gate must be deleted, not only unwired (doctor orphan-hooks)');
    assert.ok(fs.existsSync(path.join(ROOT, 'engine', 'hooks', 'turn-close.cjs')), 'turn-close.cjs must exist where the command points');
  });

  await test('FirstRun: on settings already guarded by secret-guard.cjs and dashclaw_pretool.py, adds only opening-move and turn-close and keeps the trailing newline', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-live-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    const cmd = (c) => ({ hooks: [{ type: 'command', command: c }] });
    const live = { hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|MultiEdit|Bash|PowerShell', ...cmd('node "C:/Users/x/.claude/hooks/secret-guard.cjs"') },
        { matcher: 'Agent|Task|Bash|PowerShell|Edit|Write|MultiEdit|mcp__.*', ...cmd('python "C:/Projects/DashClaw/hooks/dashclaw_pretool.py" --agent-id claude-code') },
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', ...cmd('node "C:/x/fable-delegate-guard.cjs"') },
        { matcher: 'Agent|Task|Workflow', ...cmd('node "C:/x/capability-graph-guard.cjs"') }
      ],
      UserPromptSubmit: [cmd('node "C:/x/prompt-dispatch.cjs"')],
      SessionStart: [cmd('node "C:/x/fable-delegate-guard.cjs"')],
      SubagentStart: [cmd('node "C:/x/capability-graph-guard.cjs"')],
      SubagentStop: [cmd('node "C:/x/capability-graph-guard.cjs"')]
    } };
    fs.writeFileSync(settings, JSON.stringify(live, null, 2) + '\n', 'utf8');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'advisor.md'), 'kept\n');

    firstRun.wireAgentHooks(home);

    const text = fs.readFileSync(settings, 'utf8');
    const after = JSON.parse(text);
    const cmds = (event) => (after.hooks[event] || []).flatMap(g => (g.hooks || []).map(h => h.command || ''));
    assert.strictEqual(after.hooks.PreToolUse.length, 4, `PreToolUse must stay at 4 groups: ${JSON.stringify(cmds('PreToolUse'))}`);
    assert.ok(!cmds('PreToolUse').some(c => /dashclaw-guard|secret-path-guard/.test(c)), 'a native guard must not be wired twice');
    assert.strictEqual(after.hooks.SessionStart.length, 2, 'SessionStart gains exactly the opening-move group');
    assert.strictEqual(cmds('SessionStart').filter(c => /opening-move/.test(c)).length, 1);
    assert.strictEqual(after.hooks.Stop.length, 1, 'Stop gains exactly the turn-close group');
    assert.strictEqual(cmds('Stop').filter(c => /turn-close/.test(c)).length, 1);
    assert.ok(text.endsWith('}\n'), 'settings.json must keep its trailing newline');
  });

  await test('FirstRun: raises an existing opening-move or turn-close timeout under 10 s to 10, leaves 30 s, no timeout and other hooks alone', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-raise-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    const hook = (command, timeout) => ({ type: 'command', command, ...(timeout ? { timeout } : {}) });
    fs.writeFileSync(settings, JSON.stringify({ hooks: {
      SessionStart: [{ matcher: 'startup|clear|compact', hooks: [hook('node "C:/x/engine/hooks/opening-move.cjs"', 5)] }, { hooks: [hook('node "C:/x/session-count.cjs"', 5)] }],
      Stop: [{ hooks: [hook('node "C:/x/engine/hooks/turn-close.cjs"', 5)] }, { hooks: [hook('node "C:/x/other-stop.cjs"', 3), hook('node "C:/x/turn-close-extra.cjs"', 30), hook('node "C:/x/turn-close-default.cjs"')] }]
    } }, null, 2) + '\n', 'utf8');

    firstRun.wireAgentHooks(home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const timeoutOf = (event, re) => (after.hooks[event] || []).flatMap(g => g.hooks || []).filter(h => re.test(h.command || '')).map(h => h.timeout);
    assert.deepStrictEqual(timeoutOf('SessionStart', /opening-move/), [10], 'opening-move at 5 s is raised to 10');
    assert.deepStrictEqual(timeoutOf('Stop', /turn-close\.cjs/), [10], 'turn-close at 5 s is raised to 10');
    assert.deepStrictEqual(timeoutOf('Stop', /turn-close-extra/), [30], 'a timeout already at 10 s or more is kept');
    assert.deepStrictEqual(timeoutOf('Stop', /turn-close-default/), [undefined], 'no timeout (the 60 s default) stays absent');
    assert.deepStrictEqual(timeoutOf('SessionStart', /session-count/), [5], 'another SessionStart hook keeps its timeout');
    assert.deepStrictEqual(timeoutOf('Stop', /other-stop/), [3], 'another Stop hook keeps its timeout');
  });

  // --- 8c. job contracts (jobs/install.cjs expects + EXPECTS) and the doctor jobs check ---

  await test('Jobs: every contract is the spec 2.5 table (path, maxAgeH); reapers and WesErrorLog carry none; the two new jobs are registered as written', () => {
    const install = require('../../jobs/install.cjs');
    const want = {
      HarnessParitySync: ['~/.claude/logs/port-daily.log', 26], ClaudeErrorLog: ['~/.claude/logs/errorlog/harvest.log', 26],
      CronwatchDaily: ['<repo>/tools/cronwatch/cronwatch.html', 26], DailyDistill: ['<repo>/storage/daily-distill.log', 26],
      OpeningMoveDigest: ['~/.claude/state/opening-move/digest.json', 26],
      NightlyMeditation: ['~/.claude/meditations/digests/latest-line.txt', 26], 'Harness Health Monthly': ['~/.claude/harness-health-last.txt', 768],
    };
    const got = Object.fromEntries(install.contracts(TMP_HOME).map(c => [c.name, [c.path, c.maxAgeH]]));
    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(Object.keys(install.EXPECTS).sort(), ['Harness Health Monthly', 'NightlyMeditation'], 'EXPECTS carries the jobs whose action this file does not own');
    const none = Object.entries(install.JOBS).filter(([, j]) => !j.expects).map(([n]) => n).sort();
    assert.deepStrictEqual(none, ['ClaudeAgentReaper', 'ClaudeLspReaper', 'Harness Health Monthly', 'WesErrorLog'], 'no expects on the JOBS entry (Harness Health Monthly has its contract in EXPECTS)');
    assert.strictEqual(install.knownJobs().length - install.contracts(TMP_HOME).length, 3, 'reapers and WesErrorLog are counted "no contract"');
    // Task Scheduler argument strings are Windows paths whatever the host (install.cjs W()), so the
    // expected text is built the same way; on the ubuntu CI legs path.join alone gives forward slashes.
    const W = (p) => path.join(ROOT, p).replace(/\//g, '\\');
    const dd = install.JOBS.DailyDistill;
    assert.strictEqual(dd.execute, 'pwsh.exe');
    assert.strictEqual(dd.args, `-NoProfile -ExecutionPolicy Bypass -File "${W('jobs/daily-distill.ps1')}"`);
    const om = install.JOBS.OpeningMoveDigest;
    assert.strictEqual(om.execute, process.execPath);
    assert.strictEqual(om.args, `"${W('jobs/opening-move-digest.cjs')}"`);
    assert.strictEqual(om.workingDirectory, ROOT);
    // expand() replaces only a leading "~" and "<repo>"; a "~" inside an 8.3 short name (the Windows
    // runner's C:\Users\RUNNER~1\...) is part of the home path and stays.
    for (const c of install.contracts(TMP_HOME)) assert.ok(path.isAbsolute(c.file) && !c.file.startsWith('~') && !c.file.includes('<repo>') && (c.file.startsWith(TMP_HOME) || c.file.startsWith(ROOT)), `expanded: ${c.name} -> ${c.file}`);
    assert.strictEqual(install.differs('DailyDistill', { execute: 'PWSH.EXE', args: dd.args + ' ', wd: '' }), false, 'the same action in another case and with trailing space does not differ');
    assert.strictEqual(install.differs('DailyDistill', { execute: 'pwsh.exe', args: '-File "C:/old/jobs/daily-distill.ps1"' }), true);
    assert.strictEqual(install.differs('NotOurs', { execute: 'x' }), null);
  });

  await test('Doctor jobs: a stale artifact FAILS with "STALE <name>: <file> <n> d old (limit <h> h)", an absent one with MISSING-ARTIFACT; all fresh passes and says "<n> jobs with contracts, <m> fresh"', () => {
    const { jobsCheck } = require('../doctor/doctor.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-jobs-'));
    const now = Date.now();
    const mk = (name, ageH) => { const f = path.join(dir, name + '.log'); fs.writeFileSync(f, 'x'); const t = (now - ageH * 3600e3) / 1000; fs.utimesSync(f, t, t); return { name, path: `~/${name}.log`, file: f, maxAgeH: 26 }; };
    const list = [mk('FreshJob', 2), mk('OtherFresh', 20)];
    const green = jobsCheck({ now, rows: [], list });
    assert.strictEqual(green.ok, true, green.lines.join(' | '));
    assert.ok(green.lines.some(l => /^2 jobs with contracts, 2 fresh \(\d+ known, \d+ no contract\); 0 root tasks, 0 retired or missing$/.test(l)), green.lines.join(' | '));
    const stale = jobsCheck({ now, rows: [], list: [...list, mk('StaleJob', 3 * 24 + 1)] });
    assert.strictEqual(stale.ok, false, 'seen failing: a 3-day-old artifact must fail');
    assert.ok(stale.lines.includes('STALE StaleJob: ~/StaleJob.log 3 d old (limit 26 h)'), stale.lines.join(' | '));
    assert.ok(stale.lines.some(l => /^3 jobs with contracts, 2 fresh/.test(l)), stale.lines.join(' | '));
    const gone = jobsCheck({ now, rows: [], list: [...list, { name: 'GoneJob', path: '~/gone.log', file: path.join(dir, 'gone.log'), maxAgeH: 26 }] });
    assert.strictEqual(gone.ok, false);
    assert.ok(gone.lines.includes('MISSING-ARTIFACT GoneJob: ~/gone.log'), gone.lines.join(' | '));
    const dead = jobsCheck({ now, rows: ['OldTask\tnode "C:/nowhere/at/all/x.cjs"'], list });
    assert.ok(dead.ok === true && dead.warn === true && dead.lines.some(l => /^MISSING OldTask/.test(l)), 'a missing action target still warns, never fails: ' + dead.lines.join(' | '));
  });

  // --- 9. capability-graph-guard: delegation flows downward only ---------------

  function graphEnv() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-graph-'));
    return {
      home,
      opts: {
        home,
        stateDir: path.join(home, 'state'),
        logPath: path.join(home, 'graph.jsonl'),
        env: {}
      }
    };
  }

  // Registers one subagent and returns a PreToolUse payload factory for it.
  function callerOf(opts, sid, agentId, model) {
    graphGuard.recordSubagent({
      hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId,
      agent_type: 'worker', subagent_config: { agent_type: 'worker', agent_id: agentId, model }
    }, opts);
    return (toolInput, tool = 'Agent') => ({
      hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
      cwd: 'C:/repo', tool_name: tool, tool_input: toolInput
    });
  }

  function graphEvents(opts) {
    if (!fs.existsSync(opts.logPath)) return [];
    return fs.readFileSync(opts.logPath, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
  }

  function graphKinds(opts) {
    return graphEvents(opts).map(e => e.kind);
  }

  // The REAL SubagentStart payload (measured 2026-09-02): subagent_config is
  // null, so the model only exists in the sidecar files Claude Code writes
  // under <transcript_path minus .jsonl>/subagents/.
  function nullConfigCaller(home, opts, sid, agentId, agentType) {
    const sessionDir = path.join(home, 'projects', 'proj', sid);
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
    const transcript = `${sessionDir}.jsonl`;
    const base = path.join(sessionDir, 'subagents', `agent-${agentId}`);
    const common = {
      session_id: sid, agent_id: agentId, agent_type: agentType,
      transcript_path: transcript, cwd: 'C:/repo'
    };
    return {
      sessionDir,
      writeMeta: (obj) => fs.writeFileSync(`${base}.meta.json`, JSON.stringify(obj), 'utf8'),
      writeTranscript: (lines) => fs.writeFileSync(`${base}.jsonl`, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8'),
      start: () => graphGuard.recordSubagent({
        ...common, hook_event_name: 'SubagentStart', subagent_config: null
      }, opts),
      registry: () => JSON.parse(fs.readFileSync(path.join(opts.stateDir, 'graph', `${sid}.json`), 'utf8'))[agentId],
      call: (toolInput, tool = 'Agent') => ({
        ...common, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput
      })
    };
  }

  await test('GraphGuard: rankOf maps real model ids to the capability ladder', () => {
    assert.strictEqual(graphGuard.rankOf('claude-fable-5-1'), 3);
    assert.strictEqual(graphGuard.rankOf('opus'), 2);
    assert.strictEqual(graphGuard.rankOf('claude-sonnet-5'), 1);
    assert.strictEqual(graphGuard.rankOf('haiku'), 0);
    assert.strictEqual(graphGuard.rankOf('gpt-5.6'), null);
    assert.strictEqual(graphGuard.rankOf(''), null);
    assert.strictEqual(graphGuard.rankOf(undefined), null);
  });

  await test('GraphGuard: a Sonnet subagent may spawn Haiku, never Sonnet or Opus', () => {
    const { opts } = graphEnv();
    const call = callerOf(opts, 's-son', 'agent_son', 'claude-sonnet-5');

    const reg = JSON.parse(fs.readFileSync(path.join(opts.stateDir, 'graph', 's-son.json'), 'utf8'));
    assert.strictEqual(reg.agent_son.model, 'claude-sonnet-5', JSON.stringify(reg));
    assert.strictEqual(reg.agent_son.agent_type, 'worker');

    const down = graphGuard.decide(call({ subagent_type: 'haiku-scout', model: 'haiku' }), opts);
    assert.strictEqual(down.kind, 'downward', JSON.stringify(down));
    assert.strictEqual(down.action, 'allow');

    const peer = graphGuard.decide(call({ subagent_type: 'sonnet-implementer', model: 'claude-sonnet-5' }), opts);
    assert.strictEqual(peer.action, 'deny', JSON.stringify(peer));
    assert.strictEqual(peer.kind, 'upward-or-peer');
    assert(peer.reason.startsWith(graphGuard.REASON_TEXT), `reason must carry the graph: ${peer.reason}`);

    const up = graphGuard.decide(call({ subagent_type: 'big', model: 'claude-opus-5' }), opts);
    assert.strictEqual(up.action, 'deny', JSON.stringify(up));
    assert.strictEqual(up.kind, 'upward-or-peer');

    const advisor = graphGuard.decide(call({ subagent_type: 'advisor' }), opts);
    assert.strictEqual(advisor.kind, 'advisor', JSON.stringify(advisor));
    assert.strictEqual(advisor.action, 'allow');

    assert.deepStrictEqual(graphKinds(opts), ['upward-or-peer', 'upward-or-peer', 'advisor'],
      'denials and advisor allows are logged, plain downward allows are not');
  });

  await test('GraphGuard: a Haiku subagent spawns nobody and consults nobody', () => {
    const { opts } = graphEnv();
    const call = callerOf(opts, 's-hai', 'agent_hai', 'claude-haiku-4.5');

    const leaf = graphGuard.decide(call({ subagent_type: 'haiku-scout', model: 'haiku' }), opts);
    assert.strictEqual(leaf.action, 'deny', JSON.stringify(leaf));
    assert.strictEqual(leaf.kind, 'haiku-leaf');
    assert(/Haiku spawns nobody/.test(leaf.reason), leaf.reason);

    const advisor = graphGuard.decide(call({ subagent_type: 'advisor' }), opts);
    assert.strictEqual(advisor.action, 'deny', JSON.stringify(advisor));
    assert.strictEqual(advisor.kind, 'advisor-haiku');
  });

  await test('GraphGuard: an Opus subagent may spawn Sonnet but not Fable', () => {
    const { opts } = graphEnv();
    const call = callerOf(opts, 's-opu', 'agent_opu', 'claude-opus-5');

    const down = graphGuard.decide(call({ subagent_type: 'sonnet-implementer', model: 'sonnet' }), opts);
    assert.strictEqual(down.kind, 'downward', JSON.stringify(down));

    const up = graphGuard.decide(call({ subagent_type: 'judge', model: 'claude-fable-5-1' }), opts);
    assert.strictEqual(up.action, 'deny', JSON.stringify(up));
    assert.strictEqual(up.kind, 'upward-or-peer');
  });

  await test('GraphGuard: the main loop delegates by its own session model', () => {
    const { opts } = graphEnv();
    const mainCall = (toolInput) => ({
      hook_event_name: 'PreToolUse', session_id: 's-main', cwd: 'C:/repo',
      tool_name: 'Agent', tool_input: toolInput
    });
    const fableOpts = { ...opts, sessionModelOverride: 'claude-fable-5-1' };
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'haiku']) {
      const r = graphGuard.decide(mainCall({ subagent_type: 'w', model }), fableOpts);
      assert.strictEqual(r.kind, 'downward', `${model}: ${JSON.stringify(r)}`);
    }
    const peer = graphGuard.decide(mainCall({ subagent_type: 'w', model: 'fable' }), fableOpts);
    assert.strictEqual(peer.kind, 'upward-or-peer', JSON.stringify(peer));

    const opusMain = graphGuard.decide(mainCall({ subagent_type: 'advisor' }), { ...opts, sessionModelOverride: 'claude-opus-5' });
    assert.strictEqual(opusMain.kind, 'advisor', JSON.stringify(opusMain));
    assert.strictEqual(opusMain.action, 'allow');
  });

  await test('GraphGuard: advisor consultations are counted but never capped (Wes, 2026-09-03)', () => {
    const { opts } = graphEnv();
    const a = callerOf(opts, 's-adv', 'agent_a', 'claude-sonnet-5');
    const b = callerOf(opts, 's-adv', 'agent_b', 'claude-opus-5');

    // Five from one agent, all allowed, each one counted.
    for (let i = 1; i <= 5; i++) {
      const r = graphGuard.decide(a({ subagent_type: 'advisor' }), opts);
      assert.strictEqual(r.action, 'allow', `advisor ${i}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.kind, 'advisor', `advisor ${i}: ${JSON.stringify(r)}`);
      assert(new RegExp(`consultation ${i} for this agent, ${i} for the session`).test(r.reason), r.reason);
    }
    // A second agent in the same session is also allowed; the session count keeps climbing.
    const other = graphGuard.decide(b({ subagent_type: 'advisor' }), opts);
    assert.strictEqual(other.action, 'allow', JSON.stringify(other));
    assert.strictEqual(other.kind, 'advisor');
    assert(/consultation 1 for this agent, 6 for the session/.test(other.reason), other.reason);
    assert(!/Blocked/.test(other.reason), other.reason);
  });

  await test('GraphGuard: the advisor is one rung above its caller, never a peer', () => {
    const { opts } = graphEnv();
    const sonnet = callerOf(opts, 's-esc', 'agent_s', 'claude-sonnet-5');
    const opus = callerOf(opts, 's-esc2', 'agent_o', 'claude-opus-5');
    const mainCall = (sid) => ({
      hook_event_name: 'PreToolUse', session_id: sid, cwd: 'C:/repo',
      tool_name: 'Agent', tool_input: { subagent_type: 'advisor', prompt: 'q' }
    });

    const fromSonnet = graphGuard.decide(sonnet({ subagent_type: 'advisor', prompt: 'q' }), opts);
    assert.strictEqual(fromSonnet.kind, 'advisor', JSON.stringify(fromSonnet));
    assert.strictEqual(fromSonnet.model, 'opus', 'Sonnet consults Opus, not Fable');

    const fromOpus = graphGuard.decide(opus({ subagent_type: 'advisor', prompt: 'q' }), opts);
    assert.strictEqual(fromOpus.model, 'fable', 'Opus consults Fable');

    const opusMain = graphGuard.decide(mainCall('s-esc3'), { ...opts, sessionModelOverride: 'claude-opus-5' });
    assert.strictEqual(opusMain.model, 'fable', 'an Opus main loop consults Fable');
    const fableMain = graphGuard.decide(mainCall('s-esc4'), { ...opts, sessionModelOverride: 'claude-fable-5-1' });
    assert.strictEqual(fableMain.model, 'fable', 'Fable has no rung above it');

    // A caller-supplied model is overridden: Sonnet asking for Fable still gets Opus.
    const greedy = graphGuard.decide(sonnet({ subagent_type: 'advisor', prompt: 'q', model: 'fable' }), opts);
    assert.strictEqual(greedy.model, 'opus', JSON.stringify(greedy));

    // The hook wires the model into the Agent call via updatedInput.
    const out = JSON.parse(graphGuard.main(mainCall('s-esc5'), { ...opts, sessionModelOverride: 'claude-opus-5' }));
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow', JSON.stringify(out));
    assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, { subagent_type: 'advisor', prompt: 'q', model: 'fable' });

    const escalations = graphEvents(opts).filter(e => e.kind === 'advisor').map(e => e.callee.model);
    assert.deepStrictEqual(escalations, ['opus', 'fable', 'fable', 'fable', 'opus', 'fable'], 'every consultation logs the advisor model');
  });

  await test('GraphGuard: unknown caller and unknown callee fail open, a pinned agent file is enforced', () => {
    const { home, opts } = graphEnv();

    const ghost = graphGuard.decide({
      hook_event_name: 'PreToolUse', session_id: 's-ghost', agent_id: 'never_recorded',
      cwd: 'C:/repo', tool_name: 'Agent', tool_input: { subagent_type: 'w', model: 'claude-opus-5' }
    }, opts);
    assert.strictEqual(ghost.action, 'allow', JSON.stringify(ghost));
    assert.strictEqual(ghost.kind, 'unknown-caller');
    assert.deepStrictEqual(graphKinds(opts), ['unknown-caller'], 'the unknown caller is logged once');
    graphGuard.decide({
      hook_event_name: 'PreToolUse', session_id: 's-ghost', agent_id: 'never_recorded',
      cwd: 'C:/repo', tool_name: 'Agent', tool_input: { subagent_type: 'w', model: 'claude-opus-5' }
    }, opts);
    assert.deepStrictEqual(graphKinds(opts), ['unknown-caller'], 'and only once per agent_id');

    const call = callerOf(opts, 's-unk', 'agent_unk', 'claude-sonnet-5');
    const blind = graphGuard.decide(call({ subagent_type: 'mystery' }), opts);
    assert.strictEqual(blind.kind, 'unknown-callee', JSON.stringify(blind));

    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'mystery.md'),
      '---\nname: mystery\nmodel: opus\n---\nbody\n', 'utf8');
    const pinned = graphGuard.decide(call({ subagent_type: 'mystery' }), opts);
    assert.strictEqual(pinned.action, 'deny', JSON.stringify(pinned));
    assert.strictEqual(pinned.kind, 'upward-or-peer');
    assert.strictEqual(graphGuard.calleeModel({ subagent_type: 'mystery' }, opts), 'opus');
  });

  await test('GraphGuard: subagent_config null resolves the caller from the sidecar meta.json', () => {
    const { home, opts } = graphEnv();
    const a = nullConfigCaller(home, opts, 's-meta', 'aid_meta', 'general-purpose');

    a.start();
    assert.strictEqual(a.registry().model, null, 'the real SubagentStart carries no model');
    assert.strictEqual(a.registry().agent_type, 'general-purpose');

    // meta.json lands after the start event, so resolution has to be lazy.
    a.writeMeta({ model: 'sonnet', spawnDepth: 1 });

    const peer = graphGuard.decide(a.call({ subagent_type: 'sonnet-implementer', model: 'claude-sonnet-5' }), opts);
    assert.strictEqual(peer.action, 'deny', JSON.stringify(peer));
    assert.strictEqual(peer.kind, 'upward-or-peer');

    const down = graphGuard.decide(a.call({ subagent_type: 'haiku-scout', model: 'haiku' }), opts);
    assert.strictEqual(down.kind, 'downward', JSON.stringify(down));

    const denyEvent = graphEvents(opts).find(e => e.kind === 'upward-or-peer');
    assert.strictEqual(denyEvent.caller.model, 'sonnet', JSON.stringify(denyEvent));
    assert.strictEqual(denyEvent.caller.source, 'meta');
    assert.strictEqual(denyEvent.caller.spawn_depth, 1);
  });

  await test('GraphGuard: with no meta.json the caller comes off its own transcript', () => {
    const { home, opts } = graphEnv();
    const a = nullConfigCaller(home, opts, 's-tr', 'aid_tr', 'general-purpose');

    a.start();
    a.writeTranscript([
      { type: 'user', message: { role: 'user' } },
      { type: 'assistant', message: { model: 'claude-opus-5' } }
    ]);

    const down = graphGuard.decide(a.call({ subagent_type: 'w', model: 'claude-sonnet-5' }), opts);
    assert.strictEqual(down.kind, 'downward', JSON.stringify(down));

    const peer = graphGuard.decide(a.call({ subagent_type: 'w', model: 'claude-opus-5' }), opts);
    assert.strictEqual(peer.action, 'deny', JSON.stringify(peer));
    assert.strictEqual(peer.kind, 'upward-or-peer');

    const denyEvent = graphEvents(opts).find(e => e.kind === 'upward-or-peer');
    assert.strictEqual(denyEvent.caller.model, 'claude-opus-5', JSON.stringify(denyEvent));
    // The first decide already cached it, so the deny logs source 'registry';
    // the transcript is what put it there.
    assert.strictEqual(a.registry().model_source, 'subagent-transcript', JSON.stringify(a.registry()));
  });

  await test('GraphGuard: with no sidecar files the caller comes off its agent file', () => {
    const { home, opts } = graphEnv();
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'haiku-scout.md'),
      '---\nname: haiku-scout\nmodel: haiku\n---\nbody\n', 'utf8');
    const a = nullConfigCaller(home, opts, 's-fm', 'aid_fm', 'haiku-scout');

    a.start();
    assert.strictEqual(a.registry().model, 'haiku', 'the agent file resolves at SubagentStart already');

    for (const model of ['haiku', 'claude-sonnet-5', 'claude-opus-5']) {
      const r = graphGuard.decide(a.call({ subagent_type: 'w', model }), opts);
      assert.strictEqual(r.action, 'deny', `${model}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.kind, 'haiku-leaf', `${model}: ${JSON.stringify(r)}`);
    }
  });

  await test('GraphGuard: an unresolvable caller still fails open and logs source "none"', () => {
    const { home, opts } = graphEnv();
    const a = nullConfigCaller(home, opts, 's-none', 'aid_none', 'ghost-worker');

    a.start();
    assert.strictEqual(a.registry().model, null);

    const r = graphGuard.decide(a.call({ subagent_type: 'w', model: 'claude-fable-5-1' }), opts);
    assert.strictEqual(r.action, 'allow', JSON.stringify(r));
    assert.strictEqual(r.kind, 'unknown-caller');

    const events = graphEvents(opts);
    assert.deepStrictEqual(events.map(e => e.kind), ['unknown-caller']);
    assert.strictEqual(events[0].caller.model, null, JSON.stringify(events[0]));
    assert.strictEqual(events[0].caller.source, 'none');
  });

  await test('GraphGuard: a resolved caller model is back-filled into the registry', () => {
    const { home, opts } = graphEnv();
    const a = nullConfigCaller(home, opts, 's-fill', 'aid_fill', 'general-purpose');

    a.start();
    assert.strictEqual(a.registry().model, null);

    a.writeMeta({ model: 'sonnet', spawnDepth: 2 });
    graphGuard.decide(a.call({ subagent_type: 'haiku-scout', model: 'haiku' }), opts);

    const entry = a.registry();
    assert.strictEqual(entry.model, 'sonnet', JSON.stringify(entry));
    assert.strictEqual(entry.model_source, 'meta', JSON.stringify(entry));
    assert.strictEqual(entry.spawn_depth, 2, JSON.stringify(entry));
    assert.strictEqual(entry.agent_type, 'general-purpose', JSON.stringify(entry));

    // The cached entry is now authoritative: deleting the sidecar changes nothing.
    fs.rmSync(path.join(a.sessionDir, 'subagents'), { recursive: true, force: true });
    assert.deepStrictEqual(
      graphGuard.callerModelFor(a.call({}), opts),
      { model: 'sonnet', source: 'registry', spawn_depth: 2 });
  });

  await test('GraphGuard: only Opus subagents run Workflows, and only downward ones', () => {
    const { opts } = graphEnv();
    const sonnet = callerOf(opts, 's-wf', 'agent_wf_s', 'claude-sonnet-5');
    const opus = callerOf(opts, 's-wf', 'agent_wf_o', 'claude-opus-5');
    const downScript = "await parallel([agent('a', {model: 'sonnet'}), agent('b', {model: 'haiku'})]);";
    const upScript = "await agent('a', {model: 'opus'});";

    const blocked = graphGuard.decide(sonnet({ script: downScript }, 'Workflow'), opts);
    assert.strictEqual(blocked.action, 'deny', JSON.stringify(blocked));
    assert.strictEqual(blocked.kind, 'workflow-rank');

    const ok = graphGuard.decide(opus({ script: downScript }, 'Workflow'), opts);
    assert.strictEqual(ok.kind, 'workflow-downward', JSON.stringify(ok));

    const upward = graphGuard.decide(opus({ script: upScript }, 'Workflow'), opts);
    assert.strictEqual(upward.action, 'deny', JSON.stringify(upward));
    assert.strictEqual(upward.kind, 'workflow-upward');

    const named = graphGuard.decide(opus({ name: 'tournament' }, 'Workflow'), opts);
    assert.strictEqual(named.kind, 'workflow-named', JSON.stringify(named));

    const fromMain = graphGuard.decide({
      hook_event_name: 'PreToolUse', session_id: 's-wf', cwd: 'C:/repo',
      tool_name: 'Workflow', tool_input: { script: upScript }
    }, { ...opts, sessionModelOverride: 'claude-fable-5-1' });
    assert.strictEqual(fromMain.kind, 'main-workflow', JSON.stringify(fromMain));
  });

  await test('GraphGuard: CAPABILITY_GRAPH_GUARD=off disables the guard', () => {
    const { opts } = graphEnv();
    const call = callerOf(opts, 's-off', 'agent_off', 'claude-haiku-4.5');
    const result = graphGuard.decide(call({ subagent_type: 'w', model: 'claude-fable-5-1' }),
      { ...opts, env: { CAPABILITY_GRAPH_GUARD: 'off' } });
    assert.strictEqual(result.action, 'allow', JSON.stringify(result));
    assert.strictEqual(result.kind, 'disabled');
  });

  await test('GraphGuard: main() emits the deny envelope and records SubagentStart silently', () => {
    const { opts } = graphEnv();
    assert.strictEqual(graphGuard.main({
      hook_event_name: 'SubagentStart', session_id: 's-main2', agent_id: 'agent_m',
      agent_type: 'worker', subagent_config: { model: 'claude-haiku-4.5' }
    }, opts), '', 'SubagentStart writes state and stays silent');
    assert.strictEqual(graphGuard.main({
      hook_event_name: 'SubagentStop', session_id: 's-main2', agent_id: 'agent_m'
    }, opts), '', 'SubagentStop never blocks');

    const out = graphGuard.main({
      hook_event_name: 'PreToolUse', session_id: 's-main2', agent_id: 'agent_m',
      tool_name: 'Agent', tool_input: { subagent_type: 'w', model: 'haiku' }
    }, opts);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', out);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert(parsed.hookSpecificOutput.permissionDecisionReason.startsWith(graphGuard.REASON_TEXT), out);
  });

  await test('FirstRun: wires capability-graph-guard and installs the advisor agent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-graph-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }, null, 2), 'utf8');

    firstRun.wireAgentHooks(home);
    const report = firstRun.wireAgentHooks(home); // idempotent

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const count = (event) => (after.hooks[event] || [])
      .flatMap(g => (g.hooks || []).map(h => h.command || ''))
      .filter(c => /capability-graph-guard/.test(c)).length;
    for (const event of ['PreToolUse', 'SubagentStart', 'SubagentStop']) {
      assert.strictEqual(count(event), 1, `${event} must hold exactly one capability-graph-guard entry`);
    }
    const pre = after.hooks.PreToolUse.find(g => (g.hooks || []).some(h => /capability-graph-guard/.test(h.command || '')));
    assert.strictEqual(pre.matcher, 'Agent|Task|Workflow');
    assert.strictEqual(report.claude.graphGuard, true, 'report must state the graph guard was installed');

    const source = path.join(ROOT, 'agents', 'advisor.md');
    const dest = path.join(home, '.claude', 'agents', 'advisor.md');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), fs.readFileSync(source, 'utf8'), 'advisor.md must be installed verbatim');
    assert.strictEqual(report.claude.advisorAgent, 'kept', 'the second run must keep the file it already installed');
  });

  await test('FirstRun: an existing advisor.md is kept byte-identical', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-reg-claude-advisor-'));
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8');
    const mine = '---\nname: advisor\nmodel: opus\n---\nmy own advisor\n';
    const dest = path.join(home, '.claude', 'agents', 'advisor.md');
    fs.writeFileSync(dest, mine, 'utf8');

    const report = firstRun.wireAgentHooks(home);

    assert.strictEqual(fs.readFileSync(dest, 'utf8'), mine, 'an operator-owned advisor must never be overwritten');
    assert.strictEqual(report.claude.advisorAgent, 'kept');
  });

  console.log(`\n=== Hook Regression Tests Complete: ${passed} passed, ${failed} failed (${passed + failed} total) ===`);
  if (failed > 0) process.exit(1);
}

run();
