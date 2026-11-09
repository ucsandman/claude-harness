#!/usr/bin/env node
/**
 * engine/doctor/doctor.cjs — is the installed harness the one this repository describes?
 *
 *   npm run doctor            # every check, human table, exit 1 on any FAIL
 *   npm run doctor -- --json  # machine-readable
 *
 * Every verdict carries the volume it processed (a check that touched nothing
 * prints `0 of 0`, never a bare OK). Checks:
 *
 *   links            ~/.claude/{hooks,mods,agents,workflows,tools} are links into this repo
 *   hook-wiring      every hook command in settings.json resolves, and resolves INTO this repo
 *   rules-drift      the compiled rules file matches core/rules (sync --check)
 *   claude-md        CLAUDE.md has one owner: the sync assembly, plus allowed foreign marker blocks
 *   old-refs         no tracked code/config names a retired repository or path
 *   private-boundary no tracked file outside labs/ carries a machine-absolute home path
 *   linked-leftovers untracked, unignored files inside linked directories (carried over by link)
 *   orphan-hooks     a hook file nothing registers or requires
 *   unexpected-links links at the top of the Claude home that are not ours
 *   context-graph    the module graph lints clean (no cycles, no broken required edges)
 *   deps             node >= 18, git, and the interpreters settings.json hooks need
 *   jobs             (win32) scheduled tasks pointing at retired paths; a job contract artifact stale or absent FAILS
 *   mirror-current   the starred public mirror (claude-harness/main) is at origin/master
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const link = require('../setup/link.cjs');
const HOME = os.homedir();
const CHOME = link.claudeHome(HOME);
const norm = (p) => String(p).replace(/\\/g, '/');
const expandHome = (p) => norm(p).replace(/^~(?=\/|$)/, norm(HOME));
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const inside = (child, parent) => { const c = norm(path.resolve(child)).toLowerCase(); const p = norm(path.resolve(parent)).toLowerCase(); return c === p || c.startsWith(p + '/'); };
const realOr = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
const trackedFiles = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
};
const isText = (f) => /\.(cjs|mjs|js|ts|tsx|json|md|ps1|sh|py|vbs|yml|yaml|toml|txt|html)$/i.test(f);

// claude-harness is not retired: since 2026-09-19 it is the push mirror of this repository (see mirror-current).
const RETIRED = ['claude-mods-rnd', 'mirror-sync', 'mirror-sweep', 'harness-sync', 'markdown-agent-memory/scripts', 'claude-commands'];
const RETIRED_EXEMPT = /^(docs\/PROVENANCE\.md|docs\/DECISIONS\.md|docs\/decisions\/|docs\/migration|CHANGELOG\.md|labs\/|examples\/|storage\/|engine\/doctor\/)/;
// A line that must keep a retired name (a legacy marker the engine still strips) says so: `old-ref-ok: <why>`.
const OLD_REF_OK = /old-ref-ok/;

function settingsHooks() {
  const s = readJSON(path.join(CHOME, 'settings.json')) || {};
  const out = [];
  for (const [event, groups] of Object.entries(s.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) out.push({ event, matcher: g.matcher || '*', command: String(h.command || '') });
  return out;
}
// The script a hook command runs: the first quoted path or the first token after the interpreter.
function scriptOf(command) {
  const m = /"([^"]+)"/.exec(command) || /^(?:node|python|py\s+-\S+|pwsh|powershell)\s+(?:-\S+\s+)*(\S+)/.exec(command);
  return m ? expandHome(m[1]) : null;
}

const checks = [];
const check = (id, label, fn) => checks.push({ id, label, fn });

check('links', 'installed surfaces are links into this repository', () => {
  const r = link.run({ check: true, home: HOME });
  const bad = r.links.filter((l) => l.state !== 'ok');
  return { ok: bad.length === 0, count: r.links.length, lines: bad.length ? bad.map((l) => `${l.name}: ${l.state}${l.real ? ' -> ' + norm(l.real) : ''} (npm run link)`) : [`${r.links.length} of ${r.links.length} bound`] };
});

check('hook-wiring', 'settings.json hook commands resolve into this repository', () => {
  const hooks = settingsHooks();
  const lines = []; let missing = 0, outside = 0, retired = 0;
  for (const h of hooks) {
    const s = scriptOf(h.command);
    if (RETIRED.some((r) => h.command.includes(r))) { retired++; lines.push(`RETIRED ${h.event} ${h.command.slice(0, 90)}`); }
    if (/(?:^|\s)-(?:Command|c|e)(?:\s|$)/.test(h.command)) continue; // an inline script (`powershell -Command ...`), not a file
    if (!s || !/[\\/]/.test(s)) continue; // `rtk hook claude`, `py -m module`: not a file path
    if (!fs.existsSync(s)) { missing++; lines.push(`MISSING ${h.event} ${norm(s)}`); continue; }
    const real = norm(realOr(s));
    if (inside(s, CHOME) && !inside(real, ROOT) && !/\.claude\/(hooks|tools)\//.test(norm(s))) { /* a private hook in the overlay is fine */ }
    else if (/\.claude\/(hooks|tools|mods)\//.test(norm(s)) && !inside(real, ROOT)) { outside++; lines.push(`NOT-CANONICAL ${h.event} ${norm(s)} resolves to ${real}`); }
  }
  if (!lines.length) lines.push(`${hooks.length} hook registrations checked, all resolve into this repository`);
  return { ok: missing === 0 && outside === 0 && retired === 0, count: hooks.length, lines };
});

check('prompt-hooks', 'UserPromptSubmit is one dispatcher process with a budget that survives a loaded machine', () => {
  // 2026-09-19: eight spawns per prompt at 5 s each timed out on every prompt (node startup alone was 2.6 s
  // under load) and every machine wake-up repeated the set. One process, one 30 s budget, hooks in-process.
  const groups = (readJSON(path.join(CHOME, 'settings.json')) || {}).hooks || {};
  const entries = (groups.UserPromptSubmit || []).flatMap((g) => g.hooks || []);
  const lines = []; let ok = true;
  if (entries.length !== 1) { ok = false; lines.push(`${entries.length} UserPromptSubmit commands registered; exactly one is allowed: node ~/.claude/hooks/prompt-dispatch.cjs (fold the rest into its CHAIN)`); }
  const d = entries.find((h) => /prompt-dispatch\.cjs/.test(h.command || ''));
  if (!d) { ok = false; lines.push('prompt-dispatch.cjs is not the UserPromptSubmit command'); }
  else if (!(Number(d.timeout) >= 20)) { ok = false; lines.push(`prompt-dispatch timeout is ${d.timeout ?? 'default 60'}; it must be >= 20 s (a bare node spawn measured 2.6 s under load)`); }
  const short = Object.entries(groups).flatMap(([ev, gs]) => gs.flatMap((g) => (g.hooks || []).filter((h) => h.type === 'command' && Number(h.timeout) > 0 && Number(h.timeout) < 10).map((h) => `${ev} ${(h.command || '').replace(/^\S+\s+"?[^"\s]*[\\/]/, '').slice(0, 40)} (${h.timeout}s)`)));
  if (short.length) lines.push(`${short.length} other command hook(s) still carry a timeout under 10 s: ${short.slice(0, 6).join(', ')}${short.length > 6 ? ', ...' : ''}`);
  if (!lines.length) lines.push(`1 UserPromptSubmit command (prompt-dispatch, ${d.timeout} s), 0 hooks under 10 s`);
  return { ok, warn: ok && short.length > 0, count: entries.length, lines };
});

check('rules-drift', 'generated client files match their sources (sync --check for the primary client, port --check for the rest)', () => {
  // sync owns the primary client's rules file; port owns the composite files of every other client
  // (see docs/architecture.md). Each is checked by its own writer, never by the other's.
  const sync = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'sync', 'sync.cjs'), '--check', '--target', 'claude'], { cwd: ROOT, encoding: 'utf8' });
  const port = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'harness', 'cli.cjs'), 'port', '--check'], { cwd: ROOT, encoding: 'utf8' });
  const last = (s) => (s.trim().split('\n').filter(Boolean).pop() || '').trim().slice(0, 160);
  const targets = Number((/(\d+) evaluated/.exec(sync.stdout) || [0, 0])[1]) + Number((/(\d+) target/.exec(port.stdout) || [0, 0])[1]);
  return { ok: sync.status === 0 && port.status === 0, count: targets, lines: [`sync (claude): ${last(sync.stdout) || 'exit ' + sync.status}`, `port (others): ${last(port.stdout + port.stderr) || 'exit ' + port.status}`, ...(sync.status || port.status ? ['npm run sync && npm run port'] : [])] };
});

check('claude-md', 'CLAUDE.md has one writer (sync) plus allowed marker blocks', () => {
  const f = path.join(CHOME, 'CLAUDE.md');
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!text) return { ok: false, count: 0, lines: ['CLAUDE.md missing: npm run sync'] };
  const lines = [];
  const markers = [...new Set((text.match(/<!--\s*([\w-]+)(?::start)?\s*-->/g) || []).map((m) => m.replace(/<!--\s*|\s*-->/g, '').replace(/:start$/, '')))];
  const allowed = new Set(['declick', 'agnostic:profile', 'agnostic:generated']);
  const foreign = markers.filter((m) => !allowed.has(m));
  if (!/^@.*agnostic-rules\.md\s*$/m.test(text)) lines.push('no @import of agnostic-rules.md');
  if (foreign.length) lines.push(`second writer marker(s): ${foreign.join(', ')} (the profile lives in overlay/profile.md)`);
  if (/agents-memory|agents_memory/.test(text)) lines.push('references the retired agents-memory system');
  const asm = require('../sync/claude-md.cjs').run({ check: true });
  if (asm.status === 'stale') lines.push('not what sync would assemble (npm run sync)');
  if (!lines.length) lines.push(`1 file, ${markers.length} marker block(s), one writer, assembled`);
  return { ok: !lines.some((l) => /second writer|no @import|retired|not what sync/.test(l)), count: 1, lines };
});

check('old-refs', 'no tracked code or config names a retired repository', () => {
  const files = trackedFiles().filter((f) => isText(f) && !RETIRED_EXEMPT.test(f));
  const hits = [];
  for (const f of files) {
    let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
    const kept = t.split('\n').filter((l) => !OLD_REF_OK.test(l)).join('\n');
    for (const r of RETIRED) if (kept.includes(r)) hits.push(`${f}: ${r}`);
  }
  return { ok: hits.length === 0, count: files.length, lines: hits.length ? hits.slice(0, 25) : [`${files.length} tracked files scanned, 0 retired references`] };
});

check('private-boundary', 'no tracked file outside labs/ carries a machine-absolute home path', () => {
  const files = trackedFiles().filter((f) => isText(f) && !/^(labs\/|docs\/PROVENANCE\.md|CHANGELOG\.md|examples\/|storage\/)/.test(f));
  // Only this machine's real account name is a leak; `C:\Users\<you>` and `/home/x` are placeholders.
  const me = path.basename(os.homedir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:[A-Za-z]:[\\\\/]+Users[\\\\/]+${me}|/(?:home|Users)/${me})[\\\\/]`, 'g');
  const hits = [];
  for (const f of files) {
    let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
    const m = t.match(re);
    if (m) hits.push(`${f}: ${[...new Set(m)].slice(0, 3).join(', ')}`);
  }
  return { ok: hits.length === 0, count: files.length, lines: hits.length ? hits.slice(0, 25) : [`${files.length} tracked files scanned, 0 home paths`] };
});

check('linked-leftovers', 'untracked, unignored files inside linked directories', () => {
  const dirs = link.LINKS.map((l) => l.source);
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' });
  const un = r.stdout.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
  return { ok: true, warn: un.length > 0, count: dirs.length, lines: un.length ? [`${un.length} untracked file(s) carried into linked dirs (commit, ignore or delete):`, ...un.slice(0, 20)] : [`${dirs.length} linked dirs, nothing untracked`] };
});

check('orphan-hooks', 'every hook file is registered or required somewhere', () => {
  const dir = path.join(ROOT, 'engine', 'hooks');
  const files = fs.readdirSync(dir).filter((f) => /\.(cjs|py|ps1)$/.test(f) && !/^(shim|universal-adapter|dashclaw-setup)\.cjs$/.test(f));
  const corpus = [
    ...settingsHooks().map((h) => h.command),
    fs.readFileSync(path.join(ROOT, 'core', 'port.json'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'engine', 'setup', 'first-run.cjs'), 'utf8'),
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
    ...(fs.existsSync(path.join(dir, 'adapters')) ? fs.readdirSync(path.join(dir, 'adapters')).map((f) => fs.readFileSync(path.join(dir, 'adapters', f), 'utf8')) : []),
    ...['jobs', 'git-hooks'].flatMap((d) => { const p = path.join(ROOT, d); return fs.existsSync(p) ? fs.readdirSync(p, { recursive: true }).map((f) => { try { return fs.readFileSync(path.join(p, String(f)), 'utf8'); } catch (_) { return ''; } }) : []; }),
    fs.existsSync(path.join(CHOME, 'git-hooks', 'pre-commit')) ? fs.readFileSync(path.join(CHOME, 'git-hooks', 'pre-commit'), 'utf8') : '',
  ].join('\n');
  const orphans = files.filter((f) => !corpus.includes(f) && !corpus.includes(f.replace(/\.\w+$/, '')));
  return { ok: true, warn: orphans.length > 0, count: files.length, lines: orphans.length ? orphans.map((o) => `ORPHAN engine/hooks/${o}`) : [`${files.length} hook files, all referenced`] };
});

check('unexpected-links', 'links at the top of the Claude home are ours', () => {
  const ours = new Set([...link.LINKS.map((l) => l.name), 'skills', 'commands', 'AGENTS.md', 'CLAUDE.md']);
  const odd = [];
  let n = 0;
  for (const e of fs.readdirSync(CHOME, { withFileTypes: true })) {
    if (!e.isSymbolicLink()) continue; n++;
    if (!ours.has(e.name)) odd.push(`${e.name} -> ${norm(realOr(path.join(CHOME, e.name)))}`);
  }
  return { ok: true, warn: odd.length > 0, count: n, lines: odd.length ? odd : [`${n} link(s) at the top of ${norm(CHOME)}, all expected`] };
});

check('context-graph', 'the context module graph lints clean', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine', 'context', 'cli.cjs'), 'graph'], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim().split('\n');
  const modules = (/(\d+) module/.exec(out.join('\n')) || [0, '?'])[1];
  const errors = out.filter((l) => /^s*(error|✗|FAIL)/.test(l)), warns = out.filter((l) => /^s*warn/.test(l));
  const ok = errors.length === 0 && (r.status === 0 || warns.length > 0);
  return { ok, warn: ok && warns.length > 0, count: Number(modules) || 0, lines: errors.length ? errors.slice(0, 5) : warns.length ? [`${warns.length} lint warning(s): ` + warns.map((w) => w.trim().slice(0, 90)).join(' | ').slice(0, 300)] : [out.slice(-1).join('').slice(0, 200) || `graph exit ${r.status}`] };
});

check('data-files', 'no transcript-derived data is tracked (session logs, audit trails, recordings, mined prompts)', () => {
  const re = /\.jsonl$|(^|\/)(recordings|audit|logs|out)\/[^/]+\.(json|md|txt|log)$|experiments\/[^/]+\/(turns|roster|states|results-[^/]*|suggest-[^/]*)\.json$/;
  const files = trackedFiles().filter((f) => !/^(engine\/tests\/fixtures\/|tools\/[^/]+\/tests\/)/.test(f));
  const hits = files.filter((f) => re.test(f));
  return { ok: hits.length === 0, count: files.length, lines: hits.length ? hits.slice(0, 20).map((f) => `DATA ${f}`) : [`${files.length} tracked files, 0 data files`] };
});

check('deps', 'node >= 18, git, and the interpreters hooks need', () => {
  const lines = []; let ok = true;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { ok = false; lines.push(`node ${process.versions.node} < 18`); }
  const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
  if (!has('git')) { ok = false; lines.push('git not on PATH'); }
  const cmds = settingsHooks().map((h) => h.command);
  const need = new Set();
  for (const c of cmds) { const m = /^(node|python|py|pwsh|powershell|rtk)\b/.exec(c); if (m) need.add(m[1]); }
  // Windows PowerShell 5.1 has no --version flag; `-Command exit 0` proves the shell runs.
  const probeArgs = (c) => c === 'py' ? ['-3', '--version'] : /^(pwsh|powershell)$/.test(c) ? ['-NoProfile', '-Command', 'exit 0'] : ['--version'];
  for (const c of need) if (c !== 'node' && !has(c, probeArgs(c))) { lines.push(`${c} is registered in settings.json hooks but not on PATH`); ok = false; }
  // The handoff hook names its own interpreter (`py -3.12 -m context_handoff_bundle...`); probe that one, quoted for the shell.
  const handoff = cmds.map((c) => /^((?:py\s+-\S+|python\S*))\s+-m\s+context_handoff_bundle/.exec(c)).find(Boolean);
  if (handoff && spawnSync(`${handoff[1]} -c "import context_handoff_bundle"`, { encoding: 'utf8', shell: true }).status !== 0) { lines.push(`context_handoff_bundle hooks registered but ${handoff[1]} cannot import it (pip install context-handoff-bundle)`); ok = false; }
  if (!lines.length) lines.push(`node ${process.versions.node}, git, ${[...need].join(', ') || 'no other interpreters'}`);
  return { ok, count: need.size + 2, lines };
});

/**
 * jobs: retired or missing action targets (warn), and every dead-man contract in jobs/install.cjs
 * (expects / EXPECTS): an artifact older than its limit, or absent, FAILS, because a job that exits 0
 * and writes nothing read as clean here for 51 days (NightlyMeditation, 2026-11-08). opts.rows (task
 * lines), opts.list (contracts) and opts.now / opts.home are test seams; the default reads Task Scheduler.
 */
function jobsCheck(opts = {}) {
  const now = opts.now || Date.now();
  const lines = [];
  let rows = opts.rows;
  if (!rows && process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' } | ForEach-Object { $a = $_.Actions[0]; ($_.TaskName + \"`t\" + $a.Execute + ' ' + $a.Arguments) }"], { encoding: 'utf8' });
    rows = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  }
  rows = rows || [];
  const bad = rows.filter((l) => RETIRED.some((x) => l.includes(x)) || /scripts[\\/]mirror|claude-harness/.test(l));
  const dead = rows.filter((l) => { const m = /"([^"]+\.(?:cjs|ps1|sh|vbs|py))"/.exec(l) || /(\S+\.(?:cjs|ps1|sh|vbs|py))/.exec(l); return m && /[\\/]/.test(m[1]) && !fs.existsSync(m[1]); });
  lines.push(...bad.map((l) => `RETIRED ${l.slice(0, 110)}`), ...dead.map((l) => `MISSING ${l.slice(0, 110)}`));
  const install = require('../../jobs/install.cjs');
  const cs = install.contractStatus({ now, home: opts.home, list: opts.list });
  const stale = cs.filter((c) => c.state !== 'fresh');
  for (const c of stale) {
    lines.push(c.state === 'missing' ? `MISSING-ARTIFACT ${c.name}: ${c.path}` : `STALE ${c.name}: ${c.path} ${Math.floor(c.ageMs / 86400e3)} d old (limit ${c.maxAgeH} h)`);
  }
  const known = install.knownJobs().length;
  lines.push(`${cs.length} jobs with contracts, ${cs.length - stale.length} fresh (${known} known, ${known - cs.length} no contract); ${rows.length} root tasks, ${bad.length + dead.length} retired or missing`);
  return { ok: stale.length === 0, warn: bad.length + dead.length > 0, count: rows.length + cs.length, lines };
}
check('jobs', 'scheduled tasks do not point at retired paths, and every job contract artifact is fresh (win32)', () => {
  if (process.platform !== 'win32') return { ok: true, count: 0, lines: ['not windows, 0 tasks checked'] };
  return jobsCheck();
});

check('mirror-current', 'the starred public mirror (claude-harness/main) is at origin/master', () => {
  const git = (args, timeout) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout });
  const url = git(['config', '--get', 'remote.claude-harness.url']);
  if (url.status !== 0 || !url.stdout.trim()) return { ok: false, count: 0, lines: ['no claude-harness remote: git remote add claude-harness https://github.com/ucsandman/claude-harness.git && git config remote.claude-harness.push refs/heads/master:refs/heads/main'] };
  const head = (remote, ref) => { const r = git(['ls-remote', remote, ref], 20000); return r.status === 0 ? (r.stdout.split(/\s/)[0] || '') : ''; };
  const o = head('origin', 'refs/heads/master'), m = head('claude-harness', 'refs/heads/main');
  if (!o || !m) return { ok: true, warn: true, count: (o ? 1 : 0) + (m ? 1 : 0), lines: [`${(o ? 1 : 0) + (m ? 1 : 0)} of 2 remote heads read (offline?); not checked`] };
  if (o === m) return { ok: true, count: 2, lines: [`origin/master and claude-harness/main both at ${o.slice(0, 7)}`] };
  const behind = git(['rev-list', '--count', `${m}..${o}`]);
  const n = behind.status === 0 ? behind.stdout.trim() : '?';
  return { ok: false, count: 2, lines: [`claude-harness/main ${m.slice(0, 7)} is ${n} commit(s) behind origin/master ${o.slice(0, 7)}: git push claude-harness`] };
});

function run() {
  const results = [];
  for (const c of checks) {
    let r;
    try { r = c.fn(); } catch (e) { r = { ok: false, count: 0, lines: [`check crashed: ${e.message}`] }; }
    results.push({ id: c.id, label: c.label, ...r });
  }
  return results;
}

if (require.main === module) {
  const results = run();
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ root: ROOT, home: CHOME, results }, null, 2)); process.exit(results.some((r) => !r.ok) ? 1 : 0); }
  console.log(`agnostic-ai doctor  repo=${norm(ROOT)}  home=${norm(CHOME)}\n`);
  for (const r of results) {
    const mark = !r.ok ? 'FAIL' : r.warn ? 'warn' : 'ok  ';
    console.log(`${mark}  ${r.id.padEnd(17)} ${r.label}  (${r.count})`);
    for (const l of r.lines) console.log(`      ${l}`);
  }
  const fails = results.filter((r) => !r.ok).length, warns = results.filter((r) => r.ok && r.warn).length;
  console.log(`\n${results.length} checks: ${fails} failed, ${warns} warned`);
  process.exit(fails ? 1 : 0);
}

module.exports = { run, jobsCheck };
