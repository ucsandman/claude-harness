#!/usr/bin/env node
// mirror-sync.cjs — refresh the public mirror (C:\Projects\claude-harness) from
// this harness's WORKING TREE (HEAD lags; see memory claude-repo-head-lags-working-tree).
//
//   node ~/.claude/scripts/mirror-sync.cjs            # sync + sweep, print counts
//   node ~/.claude/scripts/mirror-sync.cjs --dry-run  # list what would change
//
// What it does, in order:
//   1. copies every tracked-or-untracked-not-ignored file under SYNC_DIRS,
//      minus EXCLUDE, and git-rms mirror files under those dirs that no longer exist
//   2. copies the two engine guards settings.json loads from agnostic-ai
//   3. syncs exactly the docs the mirror already carries (curation = the mirror's docs/)
//   4. settings.json: deletes STRIP_KEYS, then fails if any SENTINEL phrase survives
//   5. CLAUDE.md = PREFACE + agnostic-rules.md (never the private profile block)
//   6. runs mirror-sweep.cjs and fails on any hit outside SWEEP_ALLOW
// It never commits. Read the counts, then commit and push in the mirror.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const SRC = path.join(HOME, '.claude');
const MIRROR = 'C:\\Projects\\claude-harness';
const ENGINE_HOOKS = 'C:\\Projects\\agnostic-ai\\engine\\hooks';
const SYNC_DIRS = ['hooks', 'git-hooks', 'agents', 'tools', 'scripts', 'workflows'];
const EXCLUDE = [/^hooks\/archive\//, /\.fable-spawn-counts/, /harness-health\.state\.json$/, /^tools\/tokflow\/.*\.json$/];
const ENGINE_GUARDS = ['capability-graph-guard.cjs', 'fable-delegate-guard.cjs'];
const STRIP_KEYS = ['autoMode'];
// Phrases that only ever appear in machine-describing blocks. Any survivor fails the sync.
const SENTINELS = ['Trusted internal domains', 'Sensitive data locations', 'Sensitive remote targets', 'Practical Systems', 'Protected IaC scopes'];
const SWEEP_ALLOW = [/^tools\/deskclaw\/tests\//];
const PREFACE = `# Global Working Agreement

This file is what my private setup loads into every Claude Code session. It is GENERATED: the source of truth lives in a separate repo (agnostic-ai/core/rules) and a sync step inlines it here, so the same rules feed CLAUDE.md, AGENTS.md (Codex) and GEMINI.md from one text. A few lines name my machine paths and tools (creds vault, agents-memory MCP, a shared inbox); read them as examples of the pattern, not as things a clone will find.

---

`;

const dry = process.argv.includes('--dry-run');
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8' });
// TRACKED files only. This used to add `--others` (untracked-not-ignored), and
// on 2026-09-06 that copied another session's uncommitted workflow — with two
// database URLs baked into an agent prompt — into the mirror's working tree
// before the sweep ran. An untracked file has not been reviewed or committed
// by anyone; the public mirror must never see it. A new file reaches the
// mirror by being committed to this harness first, which is the review step.
const listFiles = (cwd, dirs) => git(cwd, `ls-files --cached -- ${dirs.join(' ')}`).split('\n').filter(Boolean);
const untracked = (cwd, dirs) => git(cwd, `ls-files --others --exclude-standard -- ${dirs.join(' ')}`).split('\n').filter(Boolean);
const same = (a, b) => fs.existsSync(b) && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
const copy = (from, to) => { if (dry) return; fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// 0. name what is being left behind, so a missing file in the mirror is never
// a mystery: it is untracked here, and committing it is how it gets included.
const skipped = untracked(SRC, SYNC_DIRS).filter(f => !EXCLUDE.some(re => re.test(f)));
if (skipped.length) console.log(`skipped ${skipped.length} untracked (commit to include): ${skipped.join(', ')}`);

// 1. sync dirs
const want = listFiles(SRC, SYNC_DIRS).filter(f => !EXCLUDE.some(re => re.test(f)))
  // drops the `commands` submodule entry and files deleted in the working tree but still in the index
  .filter(f => fs.existsSync(path.join(SRC, f)) && fs.statSync(path.join(SRC, f)).isFile());
let copied = 0, unchanged = 0, removed = 0;
for (const f of want) {
  const a = path.join(SRC, f), b = path.join(MIRROR, f);
  if (same(a, b)) { unchanged++; continue; }
  copy(a, b); copied++; if (dry) console.log(`copy    ${f}`);
}
const wantSet = new Set(want.map(f => f.replace(/\\/g, '/')));
const engineSet = new Set(ENGINE_GUARDS.map(g => `hooks/${g}`));
for (const f of git(MIRROR, `ls-files -- ${SYNC_DIRS.join(' ')}`).split('\n').filter(Boolean)) {
  if (wantSet.has(f) || engineSet.has(f)) continue;
  removed++; if (dry) { console.log(`remove  ${f}`); continue; }
  git(MIRROR, `rm -q -- "${f}"`);
}

// 2. engine guards
for (const g of ENGINE_GUARDS) {
  const a = path.join(ENGINE_HOOKS, g), b = path.join(MIRROR, 'hooks', g);
  if (!fs.existsSync(a)) fail(`engine guard missing: ${a}`);
  if (!same(a, b)) { copy(a, b); copied++; if (dry) console.log(`copy    hooks/${g} (engine)`); } else unchanged++;
}

// 3. docs the mirror already carries, plus RTK.md
let docs = 0;
for (const f of [...git(MIRROR, 'ls-files -- docs').split('\n').filter(Boolean), 'RTK.md']) {
  const a = path.join(SRC, f), b = path.join(MIRROR, f);
  if (!fs.existsSync(a)) fail(`mirror carries ${f} but the harness no longer has it; git rm it in the mirror or restore it`);
  if (!same(a, b)) { copy(a, b); docs++; if (dry) console.log(`copy    ${f}`); }
}

// 4. settings.json with the machine-describing block(s) stripped
const settings = JSON.parse(fs.readFileSync(path.join(SRC, 'settings.json'), 'utf8'));
const stripped = STRIP_KEYS.filter(k => k in settings);
for (const k of stripped) delete settings[k];
const settingsText = JSON.stringify(settings, null, 2) + '\n';
const survivors = SENTINELS.filter(s => settingsText.includes(s));
if (survivors.length) fail(`settings.json still contains ${JSON.stringify(survivors)} after stripping ${JSON.stringify(STRIP_KEYS)}; add the owning key to STRIP_KEYS`);
if (!dry) fs.writeFileSync(path.join(MIRROR, 'settings.json'), settingsText);

// 5. CLAUDE.md
const claude = PREFACE + fs.readFileSync(path.join(SRC, 'agnostic-rules.md'), 'utf8');
if (!dry) fs.writeFileSync(path.join(MIRROR, 'CLAUDE.md'), claude);

// 6. sweep
const sweep = spawnSync(process.execPath, [path.join(SRC, 'scripts', 'mirror-sweep.cjs'), MIRROR], { encoding: 'utf8' });
if (sweep.status !== 0) fail(`sweep did not run: ${sweep.stderr}`);
const lines = sweep.stdout.split('\n').filter(Boolean);
const summary = lines[lines.length - 1];
const hits = lines.slice(0, -1).filter(l => !/^\s*$/.test(l));
const bad = hits.filter(l => { const m = l.match(/\s(\S+):\d+\s/); return !(m && SWEEP_ALLOW.some(re => re.test(m[1]))); });

console.log(`${dry ? 'DRY RUN ' : ''}mirror-sync: copied=${copied} unchanged=${unchanged} removed=${removed} docs=${docs} settings.stripped=${JSON.stringify(stripped)} sentinels=0 of ${SENTINELS.length}`);
console.log(`sweep: ${summary} (allowed=${hits.length - bad.length}, unexpected=${bad.length})`);
if (bad.length) {
  bad.forEach(l => console.log(`  UNEXPECTED ${l}`));
  // A failed sweep must leave the mirror exactly as it was. Before this, the
  // copy had already landed and the run merely exited 1, so the rejected file
  // sat in the mirror's working tree for the next `git add -A` to publish.
  // Restore every synced path to the mirror's HEAD and drop what HEAD lacks.
  if (!dry) {
    for (const l of bad) {
      const m = l.match(/\s(\S+):\d+\s/);
      if (!m) continue;
      const rel = m[1].replace(/\\/g, '/');
      const inHead = spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], { cwd: MIRROR }).status === 0;
      if (inHead) git(MIRROR, `checkout -- "${rel}"`);
      else fs.rmSync(path.join(MIRROR, rel), { force: true });
      console.log(`  rolled back ${rel} (${inHead ? 'restored from HEAD' : 'removed, not in HEAD'})`);
    }
  }
  process.exit(1);
}
if (!dry) console.log(`next: cd ${MIRROR}; bump the README "mirror synced" badge, add a CHANGELOG entry, git add -A, commit, push`);
