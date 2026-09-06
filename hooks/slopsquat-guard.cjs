#!/usr/bin/env node
// slopsquat-guard.cjs — PreToolUse [Bash|PowerShell]
// A package name from training memory is a guess, and a guessed name is how a typo-squatted
// package gets installed. Before npm/pnpm/yarn/bun/npx, pip/uv/poetry/pipx, or cargo add/install
// runs, every named package is looked up on its registry. Denied: a name the registry does not
// have (NOT FOUND); a package whose last publish is older than 24 months (STALE); one created
// in the last 14 days (BRAND NEW); a registry that could not be reached (UNVERIFIED, fail closed).
// Override for one command after checking by hand: `# PKG_OK: <why>` (logged). Session off
// switch: SLOPSQUAT_GUARD=off. Verdicts cache for 7 days in ~/.claude/logs/slopsquat-cache.json.
// Ported from ELAI's anti-slopsquatting rule, 2026-09-06; the deny reason carries the lookup URL.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
const OK = /PKG_OK:/;
const STALE_DAYS = 730, NEW_DAYS = 14, CACHE_DAYS = 7, TIMEOUT_MS = 4000;
const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
const CACHE = path.join(LOG_DIR, 'slopsquat-cache.json');

// Which registry a command consults, and where its package names start.
// [regex over the command words joined by spaces, registry, index of first package word]
const INSTALLERS = [
  [/^(npm)\s+(i|install|add|isntall|in)\b/, 'npm'],
  [/^(pnpm)\s+(add|i|install)\b/, 'npm'],
  [/^(yarn)\s+add\b/, 'npm'],
  [/^(bun)\s+(add|i|install)\b/, 'npm'],
  [/^(npx|bunx)\s/, 'npm'],
  [/^(pnpm)\s+dlx\b/, 'npm'],
  [/^(pip3?|python(3)?\s+-m\s+pip|py\s+-3(\.\d+)?\s+-m\s+pip)\s+install\b/, 'pypi'],
  [/^(uv)\s+(add|pip\s+install)\b/, 'pypi'],
  [/^(poetry)\s+add\b/, 'pypi'],
  [/^(pipx)\s+install\b/, 'pypi'],
  [/^(cargo)\s+(add|install)\b/, 'crates'],
];
const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '-t', '--target', '--prefix',
  '--registry', '-w', '--workspace', '--filter', '-C', '--cwd', '-p', '--python', '--group', '-G', '--features', '--git', '--path', '--tag', '--rev', '--branch']);

function segments(cmd) { return cmd.split(/\s*(?:;|&&|\|\||\||\n|\r\n)\s*/).map((s) => s.trim()).filter(Boolean); }
function words(seg) { const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]); return out; }
function stripWrappers(seg) { return seg.replace(/^\(+\s*/, '').replace(/^(?:(?:sudo|env|nice|time|rtk)\s+)+/, '').replace(/^(?:\S+=\S*\s+)+/, ''); }

// Bare package names named by one segment: [{name, registry}] or [] when it is not an install.
function packagesIn(seg) {
  const clean = stripWrappers(seg);
  const w = words(clean);
  if (!w.length) return [];
  const joined = w.join(' ');
  const hit = INSTALLERS.find(([re]) => re.test(joined));
  if (!hit) return [];
  const registry = hit[1];
  const head = joined.match(hit[0])[0];
  const rest = words(joined.slice(head.length));
  const isRunner = /^(npx|bunx|pnpm dlx)/.test(head);
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('-')) { if (VALUE_FLAGS.has(tok)) i++; continue; }
    if (tok === '--') continue;
    // Not a registry name: a path, a URL, a git ref, an archive, a requirements file, an env-style token.
    if (/^(\.|\/|~|[A-Za-z]:[\\/]|file:|git\+|git:|https?:|ssh:|github:|gitlab:)/.test(tok) || /\.(tar\.gz|tgz|whl|zip|txt|toml|lock)$/.test(tok) || tok.includes('=') && !/^[A-Za-z0-9@._\-\/[\]]+[=<>~!]/.test(tok)) continue;
    let name = tok;
    if (registry === 'npm') name = name.startsWith('@') ? name.replace(/(@[^/]+\/[^@]+)@.*$/, '$1') : name.replace(/@.*$/, '');
    else if (registry === 'pypi') name = name.replace(/\[.*$/, '').replace(/[=<>~!;].*$/, '');
    else name = name.replace(/@.*$/, '');
    if (!/^(@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/.test(name)) continue;
    out.push({ name: registry === 'pypi' ? name.toLowerCase().replace(/[._]+/g, '-') : name, registry });
    if (isRunner) break; // npx <pkg> <args to the pkg>
  }
  return out;
}

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }
function writeCache(c) { try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch { /* best effort */ } }
function log(kind, what) { try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'slopsquat-guard.log'), `${new Date().toISOString()}\t${kind}\t${String(what).replace(/\s+/g, ' ').slice(0, 300)}\n`); } catch { /* best effort */ } }

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'slopsquat-guard/1 (claude-harness hook)', accept: 'application/json' } });
    if (r.status === 404) return { missing: true };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { json: await r.json() };
  } finally { clearTimeout(t); }
}
const daysAgo = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

// → {verdict: OK|NOT FOUND|STALE|BRAND NEW|UNVERIFIED, detail, url}
async function lookup({ name, registry }) {
  let url, res;
  try {
    if (registry === 'npm') {
      url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
      res = await fetchJson(url);
      if (res.missing) return { verdict: 'NOT FOUND', url };
      const time = res.json.time || {};
      const latest = (res.json['dist-tags'] || {}).latest;
      return judge(time.created, time[latest] || time.modified, url, latest);
    }
    if (registry === 'pypi') {
      url = `https://pypi.org/pypi/${name}/json`;
      res = await fetchJson(url);
      if (res.missing) return { verdict: 'NOT FOUND', url };
      const rel = res.json.releases || {};
      const times = Object.values(rel).flat().map((f) => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort();
      const latest = (res.json.info || {}).version;
      const latestTimes = (rel[latest] || []).map((f) => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort();
      return judge(times[0], latestTimes[latestTimes.length - 1] || times[times.length - 1], url, latest);
    }
    url = `https://crates.io/api/v1/crates/${name}`;
    res = await fetchJson(url);
    if (res.missing) return { verdict: 'NOT FOUND', url };
    const c = res.json.crate || {};
    return judge(c.created_at, c.updated_at, url, c.max_stable_version || c.max_version);
  } catch (e) {
    return { verdict: 'UNVERIFIED', url, detail: e.name === 'AbortError' ? `no answer in ${TIMEOUT_MS}ms` : e.message };
  }
}
function judge(created, lastPublish, url, version) {
  if (created && daysAgo(created) < NEW_DAYS) return { verdict: 'BRAND NEW', url, detail: `created ${created.slice(0, 10)}` };
  if (lastPublish && daysAgo(lastPublish) > STALE_DAYS) return { verdict: 'STALE', url, detail: `last publish ${lastPublish.slice(0, 10)}` };
  return { verdict: 'OK', url, detail: `${version || ''} published ${(lastPublish || '').slice(0, 10)}` };
}

async function check(pkgs) {
  const cache = readCache();
  const out = [];
  let dirty = false;
  for (const p of pkgs) {
    const key = `${p.registry}:${p.name}`;
    const hit = cache[key];
    if (hit && hit.verdict !== 'UNVERIFIED' && daysAgo(hit.at) < CACHE_DAYS) { out.push({ ...p, ...hit, cached: true }); continue; }
    const r = await lookup(p);
    cache[key] = { ...r, at: new Date().toISOString() };
    dirty = true;
    out.push({ ...p, ...r });
  }
  if (dirty) writeCache(cache);
  return out;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

async function main() {
  if (/^(off|0|false)$/i.test(process.env.SLOPSQUAT_GUARD || '')) return;
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  if (!SHELL_TOOLS.has(input.tool_name || '')) return;
  const cmd = String((input.tool_input || {}).command || '');
  if (!cmd.trim()) return;
  if (OK.test(cmd)) { log('override', cmd); return; }
  const pkgs = [];
  const seen = new Set();
  for (const seg of segments(cmd)) for (const p of packagesIn(seg)) { const k = `${p.registry}:${p.name}`; if (!seen.has(k)) { seen.add(k); pkgs.push(p); } }
  if (!pkgs.length) return;
  const results = await check(pkgs);
  const bad = results.filter((r) => r.verdict !== 'OK');
  log(bad.length ? 'deny' : 'ok', results.map((r) => `${r.registry}:${r.name}=${r.verdict}${r.cached ? '(cached)' : ''}`).join(' '));
  if (!bad.length) return;
  const lines = bad.map((r) => `  ${r.verdict.padEnd(10)} ${r.registry}:${r.name}${r.detail ? ` (${r.detail})` : ''}  ${r.url}`);
  deny(`[slopsquat-guard] a package name is not verified on its registry:\n${lines.join('\n')}\nNOT FOUND is the hallucinated-name case: search the registry for the real package before retrying. STALE (no publish in ${STALE_DAYS / 365 | 0} years) and BRAND NEW (under ${NEW_DAYS} days old) need a reason. UNVERIFIED means the registry did not answer; retry, or check by hand. After checking, append \`# PKG_OK: <why>\` to this exact command (logged).`);
}

if (require.main === module) main().then(() => process.exit(0), (e) => { log('error', e.message); process.exit(0); });
module.exports = { packagesIn, segments };
