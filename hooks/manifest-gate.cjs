#!/usr/bin/env node
/**
 * manifest-gate.cjs — declared-vs-actual change verification at commit time.
 *
 * WHY THIS EXISTS
 *   Every other guard in this harness is an INPUT guard: secret-guard controls
 *   what gets written, scope-lock controls where, agent-model-guard controls who
 *   gets spawned, DashClaw controls what is permitted. Nothing checked the
 *   OUTPUT side — whether the agent actually did what it said it would do.
 *
 *   CLAUDE.md asks for that in three places (§3 Surgical Changes, the DEVIATIONS
 *   log, and "THINGS I DIDN'T TOUCH" in the summary template). All three were
 *   prose, enforced only by the model choosing to comply. This makes them an
 *   exit code.
 *
 *   Second job: the manifest can carry `verify` commands. The single most
 *   repeated failure in ~/.claude/docs/opus-handoff.md is claiming "done"
 *   without running anything (a dashboard bug was declared fixed ~10 times).
 *   Declared acceptance criteria run automatically before the commit lands.
 *
 * NOT A DUPLICATE OF DASHCLAW
 *   dashclaw_plan_submit is forward-looking AUTHORIZATION: it pre-approves
 *   guarded actions so a run is not interrupted. It never sees files and never
 *   compares intent to result. This is backward-looking VERIFICATION. Different
 *   axis; they compose fine.
 *
 * USAGE
 *   node manifest-gate.cjs set --goal "..." --allow "src/**" --allow "README.md"
 *                             [--verify "npm run typecheck"] [--verify "npm test"]
 *   node manifest-gate.cjs check     # run by the global pre-commit hook
 *   node manifest-gate.cjs status    # print state + write the HTML report
 *   node manifest-gate.cjs clear     # drop the manifest for this repo
 *
 * OPT-IN BY DESIGN
 *   No manifest for the repo => `check` exits 0 immediately. Quick one-line
 *   fixes are not slowed down. The gate only bites once you have declared intent.
 *
 * KEYED BY REPO, NOT SESSION
 *   A commit happens in a repo, and the pre-commit hook gets no session id, so
 *   the manifest is stored per repo root. The creating session id is recorded in
 *   the file and shown in the report. LIMITATION: two agents working the same
 *   repo at once share one manifest — use scope-lock for that case instead.
 *
 * FAILURE POSTURE: FAIL CLOSED (deliberately different from secret-guard)
 *   secret-guard fails open because a broken guard must never wedge the editor.
 *   This one fails closed: a verification gate that silently passes when it
 *   breaks is exactly the failure mode it was built to remove. A blocked commit
 *   is one flag away from proceeding (`git commit --no-verify`) and every block
 *   message prints that escape hatch.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const MANIFEST_DIR = path.join(os.homedir(), '.claude', 'manifests');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // stale-manifest cleanup
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TAIL_LINES = 25;

// ─── small helpers ────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repoRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim().replace(/\r/g, '');
  } catch {
    return null;
  }
}

// Stable filename per repo. Keeps the repo itself clean (nothing to accidentally
// commit) and mirrors how scope-lock stores state under ~/.claude.
function slug(root) {
  return root.replace(/\\/g, '/').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function manifestPath(root) {
  return path.join(MANIFEST_DIR, `${slug(root)}.json`);
}

function reportPath(root) {
  return path.join(MANIFEST_DIR, `${slug(root)}.report.html`);
}

function readManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
  } catch {
    return null;
  }
}

function cleanupStale() {
  try {
    for (const f of fs.readdirSync(MANIFEST_DIR)) {
      const fp = path.join(MANIFEST_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_AGE_MS) fs.unlinkSync(fp);
    }
  } catch {}
}

// ─── glob matching ────────────────────────────────────────────────────────
// Minimal on purpose: `**` spans separators, `*` and `?` do not. A directory
// pattern with no wildcard ("src") matches everything under it. Writing a full
// glob engine here would be more code than the gate itself.
function toRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Bare path or directory prefix also matches everything beneath it.
  return new RegExp(`^${out}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '');
}

function matchesAny(file, patterns) {
  const f = file.replace(/\\/g, '/');
  return patterns.some((pat) => toRegExp(pat).test(f));
}

// ─── staged changes ───────────────────────────────────────────────────────
// --name-status with rename detection so a rename reports BOTH paths. Using
// --name-only would hide the source path of a rename, which is precisely the
// "you deleted something you never declared" case worth catching.
function stagedChanges(root) {
  const raw = git(['diff', '--cached', '--name-status', '-M'], root);
  const out = [];
  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r/g, '').trim();
    if (!clean) continue;
    const parts = clean.split('\t');
    const status = parts[0];
    if (/^[RC]/.test(status) && parts.length >= 3) {
      out.push({ status: status[0] === 'R' ? 'renamed from' : 'copied from', file: parts[1] });
      out.push({ status: status[0] === 'R' ? 'renamed to' : 'copied to', file: parts[2] });
    } else if (parts.length >= 2) {
      const map = { A: 'added', M: 'modified', D: 'deleted', T: 'typechange' };
      out.push({ status: map[status[0]] || status, file: parts[1] });
    }
  }
  return out;
}

// ─── verify commands ──────────────────────────────────────────────────────

function runVerify(commands, root) {
  const results = [];
  for (const cmd of commands) {
    const started = Date.now();
    try {
      const stdout = execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        timeout: VERIFY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32' ? undefined : '/bin/sh',
      });
      results.push({ cmd, ok: true, ms: Date.now() - started, output: String(stdout || '') });
    } catch (err) {
      const output = `${(err && err.stdout) || ''}${(err && err.stderr) || ''}` || String((err && err.message) || 'failed');
      results.push({ cmd, ok: false, ms: Date.now() - started, output: String(output) });
    }
  }
  return results;
}

function tail(text, n) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(Boolean);
  return lines.slice(-n).join('\n');
}

// ─── HTML report ──────────────────────────────────────────────────────────
// §5 of CLAUDE.md: a terminal-only surface is not a surface. On every check the
// gate writes a self-contained page and prints a file:// link to it, so a
// blocked commit can be understood by looking rather than by parsing stderr.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function writeReport(root, manifest, changes, offPlan, verifyResults, passed) {
  const rows = changes.map((c) => {
    const bad = offPlan.some((o) => o.file === c.file && o.status === c.status);
    return `<tr class="${bad ? 'bad' : 'ok'}">
      <td class="fit"><span class="pill ${bad ? 'pill-bad' : 'pill-ok'}">${bad ? 'OFF PLAN' : 'declared'}</span></td>
      <td class="mono fit">${esc(c.status)}</td>
      <td class="mono">${esc(c.file)}</td></tr>`;
  }).join('\n');

  const allowRows = (manifest.allow || []).map((a) => {
    const used = changes.some((c) => matchesAny(c.file, [a]));
    return `<tr><td class="mono">${esc(a)}</td><td>${used ? '<span class="pill pill-ok">touched</span>' : '<span class="pill pill-idle">untouched</span>'}</td></tr>`;
  }).join('\n');

  // Render from the DECLARED list, not from the results. When the file check
  // fails the verify commands never run, and reporting that as "none declared"
  // would claim there were no acceptance criteria when there were.
  const declaredVerify = manifest.verify || [];
  const byCmd = new Map(verifyResults.map((v) => [v.cmd, v]));
  const skipped = declaredVerify.filter((c) => !byCmd.has(c)).length;
  const verifyRows = declaredVerify.map((cmd) => {
    const v = byCmd.get(cmd);
    if (!v) {
      return `<tr><td class="fit"><span class="pill pill-idle">not run</span></td>
      <td class="mono">${esc(cmd)}</td><td class="mono num">&mdash;</td></tr>`;
    }
    return `<tr class="${v.ok ? 'ok' : 'bad'}">
      <td class="fit"><span class="pill ${v.ok ? 'pill-ok' : 'pill-bad'}">${v.ok ? 'pass' : 'FAIL'}</span></td>
      <td class="mono">${esc(v.cmd)}</td>
      <td class="mono num">${(v.ms / 1000).toFixed(1)}s</td></tr>
      ${v.ok ? '' : `<tr class="bad"><td></td><td colspan="2"><pre>${esc(tail(v.output, VERIFY_TAIL_LINES))}</pre></td></tr>`}`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manifest Gate</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a19;--muted:#6b6b66;--line:#e4e4e0;--card:#fff;
      --ok:#1a7f4b;--okbg:#e6f4ec;--bad:#b3261e;--badbg:#fdeceb;--idle:#8a8a84;--idlebg:#f0f0ed;}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#ececea;--muted:#9a9a94;--line:#2c2c31;--card:#1e1e22;
      --ok:#5ad48f;--okbg:#12301f;--bad:#ff8f85;--badbg:#3a1512;--idle:#7d7d77;--idlebg:#26262b;}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--fg);
     font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,system-ui,sans-serif}
.wrap{max-width:940px;margin:0 auto}
h1{font-size:1.45rem;margin:0 0 .2rem;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 1.5rem;font-size:.9rem}
.verdict{padding:.85rem 1.1rem;border-radius:10px;font-weight:600;margin:0 0 1.5rem;border:1px solid transparent}
.verdict.pass{background:var(--okbg);color:var(--ok);border-color:var(--ok)}
.verdict.fail{background:var(--badbg);color:var(--bad);border-color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.15rem;margin:0 0 1.15rem}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:0 0 .7rem;font-weight:600}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.88rem}
td{padding:.4rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.85em}
.num{text-align:right;color:var(--muted);white-space:nowrap}
.fit{width:1%;white-space:nowrap}
.note{color:var(--muted);font-size:.83rem;margin:.7rem 0 0}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.72rem;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.pill-ok{background:var(--okbg);color:var(--ok)}
.pill-bad{background:var(--badbg);color:var(--bad)}
.pill-idle{background:var(--idlebg);color:var(--idle)}
pre{margin:.3rem 0 0;padding:.6rem .75rem;background:var(--bg);border:1px solid var(--line);
    border-radius:7px;overflow-x:auto;font-size:.8rem;line-height:1.45}
.goal{font-size:1rem;margin:0}
.meta{color:var(--muted);font-size:.82rem;margin:.45rem 0 0}
.empty{color:var(--muted);font-size:.88rem;margin:0}
.hint{color:var(--muted);font-size:.82rem;margin:1.5rem 0 0;text-align:center}
code{font-family:ui-monospace,Consolas,monospace;background:var(--idlebg);padding:.1rem .35rem;border-radius:4px}
</style></head><body><div class="wrap">
<h1>Manifest Gate</h1>
<p class="sub">${esc(root)}</p>
<p class="verdict ${passed ? 'pass' : 'fail'}">${passed ? 'PASS — the commit matches what was declared' : 'BLOCKED — the commit does not match what was declared'}</p>

<div class="card">
  <h2>Declared goal</h2>
  <p class="goal">${esc(manifest.goal || '(none given)')}</p>
  <p class="meta">Created ${esc(manifest.created || '?')}${manifest.session ? ` &middot; session ${esc(String(manifest.session).slice(0, 8))}` : ''}</p>
</div>

<div class="card"><h2>Staged changes vs manifest</h2>
  <div class="scroll"><table>${rows || '<tr><td class="empty">Nothing staged.</td></tr>'}</table></div>
</div>

<div class="card"><h2>Declared paths</h2>
  <div class="scroll"><table>${allowRows || '<tr><td class="empty">No paths declared.</td></tr>'}</table></div>
</div>

<div class="card"><h2>Verify commands</h2>
  ${declaredVerify.length
    ? `<div class="scroll"><table>${verifyRows}</table></div>${skipped ? '<p class="note">Skipped: the staged-file check failed first, so nothing was executed. Fix the off-plan changes and commit again to run these.</p>' : ''}`
    : '<p class="empty">None declared. Add <code>--verify "npm run typecheck"</code> to enforce acceptance criteria here.</p>'}
</div>

<p class="hint">Regenerate with <code>node ~/.claude/hooks/manifest-gate.cjs status</code> &middot; bypass once with <code>git commit --no-verify</code></p>
</div></body></html>`;

  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(reportPath(root), html);
  return reportPath(root);
}

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
}

// ─── commands ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { goal: '', allow: [], verify: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--goal') out.goal = argv[++i] || '';
    else if (a === '--allow') out.allow.push(argv[++i] || '');
    else if (a === '--verify') out.verify.push(argv[++i] || '');
  }
  out.allow = out.allow.filter(Boolean);
  out.verify = out.verify.filter(Boolean);
  return out;
}

function cmdSet(root, argv) {
  const a = parseArgs(argv);
  if (!a.allow.length) {
    console.error('manifest-gate: --allow is required (at least one path or glob).');
    return 2;
  }
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const manifest = {
    goal: a.goal,
    repo: root,
    session: process.env.CLAUDE_SESSION_ID || '',
    created: new Date().toISOString(),
    allow: a.allow,
    verify: a.verify,
  };
  fs.writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2));
  cleanupStale();
  console.log(`manifest-gate: ARMED for ${root}`);
  console.log(`  goal:   ${a.goal || '(none)'}`);
  console.log(`  allow:  ${a.allow.join(', ')}`);
  console.log(`  verify: ${a.verify.length ? a.verify.join(' && ') : '(none)'}`);
  console.log('  Commits touching anything outside "allow" will be blocked.');
  return 0;
}

function cmdClear(root) {
  try { fs.unlinkSync(manifestPath(root)); } catch {}
  try { fs.unlinkSync(reportPath(root)); } catch {}
  console.log(`manifest-gate: cleared for ${root}`);
  return 0;
}

function cmdCheck(root, { quiet } = {}) {
  const manifest = readManifest(root);
  if (!manifest) return 0; // opt-in: no manifest, no gate

  const changes = stagedChanges(root);
  if (!changes.length) return 0; // nothing staged (e.g. amend of message only)

  const allow = manifest.allow || [];
  const offPlan = changes.filter((c) => !matchesAny(c.file, allow));

  // Verify commands only run when the file check passed — no point spending
  // 30s on a typecheck for a commit that is already going to be rejected.
  const verifyResults = offPlan.length ? [] : runVerify(manifest.verify || [], root);
  const verifyFailed = verifyResults.filter((v) => !v.ok);
  const passed = offPlan.length === 0 && verifyFailed.length === 0;

  let report = '';
  try { report = writeReport(root, manifest, changes, offPlan, verifyResults, passed); } catch {}

  if (passed) {
    if (!quiet) {
      const bits = [`${changes.length} change(s) match the manifest`];
      if (verifyResults.length) bits.push(`${verifyResults.length} verify command(s) passed`);
      console.log(`  ✓ manifest-gate: ${bits.join(', ')}`);
    }
    return 0;
  }

  console.log('');
  console.log('  ✗ manifest-gate: COMMIT BLOCKED');
  console.log(`    goal: ${manifest.goal || '(none declared)'}`);

  if (offPlan.length) {
    console.log('');
    console.log(`    ${offPlan.length} staged change(s) were never declared:`);
    for (const c of offPlan.slice(0, 15)) console.log(`      ${c.status.padEnd(16)} ${c.file}`);
    if (offPlan.length > 15) console.log(`      ... and ${offPlan.length - 15} more`);
    console.log('');
    console.log(`    Declared paths: ${allow.join(', ')}`);
    console.log('    Either unstage them, or declare them (this is your DEVIATIONS entry):');
    console.log(`      node "${__filename}" set --goal "${(manifest.goal || '').replace(/"/g, '')}" ${allow.concat(offPlan.map((c) => c.file)).map((p) => `--allow "${p}"`).join(' ')}`);
  }

  for (const v of verifyFailed) {
    console.log('');
    console.log(`    verify FAILED: ${v.cmd}`);
    const t = tail(v.output, 12);
    for (const line of t.split('\n')) console.log(`      ${line}`);
  }

  if (report) {
    console.log('');
    console.log(`    Full report: ${fileUrl(report)}`);
  }
  console.log('    Bypass once with: git commit --no-verify');
  console.log('');
  return 1;
}

function cmdStatus(root) {
  const manifest = readManifest(root);
  if (!manifest) {
    console.log(`manifest-gate: no manifest for ${root} (gate inactive).`);
    return 0;
  }
  const changes = stagedChanges(root);
  const offPlan = changes.filter((c) => !matchesAny(c.file, manifest.allow || []));
  const report = writeReport(root, manifest, changes, offPlan, [], offPlan.length === 0);
  console.log(`manifest-gate: ACTIVE for ${root}`);
  console.log(`  goal:      ${manifest.goal || '(none)'}`);
  console.log(`  allow:     ${(manifest.allow || []).join(', ')}`);
  console.log(`  verify:    ${(manifest.verify || []).length ? manifest.verify.join(' && ') : '(none)'}`);
  console.log(`  staged:    ${changes.length} change(s), ${offPlan.length} off plan`);
  console.log(`  report:    ${fileUrl(report)}`);
  return 0;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (process.env.MANIFEST_GATE_SKIP === '1') return 0;

  const root = repoRoot();
  if (!root) {
    if (cmd === 'check') return 0; // not a git repo -> nothing to gate
    console.error('manifest-gate: not inside a git repository.');
    return 2;
  }

  switch (cmd) {
    case 'set': return cmdSet(root, rest);
    case 'check': return cmdCheck(root, { quiet: rest.includes('--quiet') });
    case 'status': return cmdStatus(root);
    case 'clear': return cmdClear(root);
    default:
      console.log('usage: manifest-gate.cjs set --goal "..." --allow <path|glob> [--allow ...] [--verify "<cmd>"]');
      console.log('       manifest-gate.cjs check | status | clear');
      return 2;
  }
}

// FAIL CLOSED on an internal error (see header). A silently-passing
// verification gate is the bug this file exists to remove.
try {
  process.exit(main());
} catch (err) {
  console.error(`  ✗ manifest-gate: internal error, failing closed: ${err && err.message}`);
  console.error('    Bypass once with: git commit --no-verify');
  process.exit(1);
}
