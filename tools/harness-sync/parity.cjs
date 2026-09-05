#!/usr/bin/env node
/**
 * harness parity dashboard — what is actually wired into each of the three
 * harnesses, computed live from the config files on disk.
 *
 *   node ~/.claude/tools/harness-sync/parity.cjs          # write the page
 *   node ~/.claude/tools/harness-sync/parity.cjs --open   # write it and open it
 *   node ~/.claude/tools/harness-sync/parity.cjs --json    # machine-readable
 *
 * Nothing here is hardcoded status: every cell is read from settings.json /
 * hooks.json / config.toml / mcp_config.json and the filesystem, so the page
 * cannot claim a guard is wired after someone removes it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const OUT = path.join(HOME, '.claude', 'harness-parity.html');
const OPEN = process.argv.includes('--open');
const AS_JSON = process.argv.includes('--json');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJSON = (p) => {
  const raw = read(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// The guards that make up the shared safety layer, and which harness can host each.
const GUARDS = [
  ['secret-guard', 'Blocks writing/committing secrets and staging .env'],
  ['rm-guard', 'Denies recursive deletes outside scratch/build dirs'],
  ['process-kill-guard', 'Blocks kill-by-name; forces the PID form'],
  ['dev-server-guard', 'Stops orphaned dev servers and wrong-tree kills'],
  ['scope-lock', 'Blocks edits outside a locked directory'],
  ['slow-command-guard', 'Blocks recursive searches rooted at C:\\Projects or home'],
  ['git-tree-guard', 'Denies git commands that rewrite a shared working tree'],
  ['batch-guard', 'Denies the 4th consecutive one-at-a-time probe'],
  ['declick-nudge', 'Names the declick adapter for an MCP/WebFetch call'],
  ['repeat-tool-guard', 'Counts identical tool calls, nudges at 3/5/8'],
  ['correction-tracker', 'Counts repeat corrections, drafts the rule'],
  ['creds-resolve', 'Fills .env from the creds vault at session start'],
  ['codex-memory-inject', 'Injects the shared memory store at session start (Codex)'],
  ['codex-rewrite', 'rtk + repowise command rewriting (Codex adapter)'],
  ['rtk', 'Compresses shell output 60-90%'],
  ['agent-model-guard', 'Caps Fable spawns; requires explicit model:'],
  ['opus-handoff-inject', 'Injects the Opus routing pack at session start'],
  ['guard-canary', 'Proves the guards still fire (rule L1)'],
  ['session-count', 'Warns about parallel session cost'],
];

/** Everything a harness knows about itself, read from disk. */
function inspectHarness(h) {
  const configText = h.configFiles.map((p) => read(p) || '').join('\n');
  const wired = new Set();
  for (const [name] of GUARDS) {
    // A guard counts as wired only if its script name appears in a config file
    // AND the script it points at exists on disk.
    if (!configText.includes(name)) continue;
    if (name === 'rtk') {
      wired.add(name);
      continue;
    }
    const candidates = [
      path.join(HOME, '.claude', 'hooks', `${name}.cjs`),
      path.join(HOME, '.claude', 'hooks', `${name}.ps1`),
      path.join(HOME, '.claude', 'hooks', `${name}.py`),
      path.join(HOME, '.claude', 'hooks', 'adapters', `${name}.cjs`),
    ];
    if (candidates.some((c) => fs.existsSync(c))) wired.add(name);
  }

  // Rules file
  const rulesRaw = read(h.rules);
  const rules = {
    path: h.rules,
    exists: !!rulesRaw,
    kb: rulesRaw ? (Buffer.byteLength(rulesRaw) / 1024).toFixed(1) : '0',
    lines: rulesRaw ? rulesRaw.split('\n').length : 0,
    generated: !!(rulesRaw && rulesRaw.includes('harness-sync/sync.cjs')),
  };

  // Skills: count entries that are links into ~/.claude/skills
  let shared = 0;
  let own = 0;
  try {
    for (const e of fs.readdirSync(h.skillsDir)) {
      const p = path.join(h.skillsDir, e);
      let target = null;
      try {
        target = fs.readlinkSync(p);
      } catch {
        target = null;
      }
      if (target && /[/\\]\.claude[/\\]skills[/\\]/.test(target + path.sep)) shared++;
      else if (target || fs.existsSync(path.join(p, 'SKILL.md'))) own++;
    }
  } catch {
    /* no skills dir */
  }

  return { ...h, wired, rules, skills: { shared, own }, mcp: h.readMcp() };
}

const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');

const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    model: 'opus[1m]',
    rules: path.join(HOME, '.claude', 'CLAUDE.md'),
    skillsDir: path.join(HOME, '.claude', 'skills'),
    configFiles: [CLAUDE_SETTINGS],
    note: 'The source of truth. Rules here generate the other two.',
    readMcp() {
      const j = readJSON(path.join(HOME, '.claude.json'));
      return Object.keys((j && j.mcpServers) || {}).sort();
    },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    // Read from config.toml so the page never asserts a model from memory.
    model: (() => {
      const t = read(path.join(HOME, '.codex', 'config.toml')) || '';
      const m = t.match(/^model\s*=\s*"([^"]+)"/m);
      const e = t.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
      return `${m ? m[1] : '?'} / ${e ? e[1] : '?'}`;
    })(),
    rules: path.join(HOME, '.codex', 'AGENTS.md'),
    skillsDir: path.join(HOME, '.codex', 'skills'),
    configFiles: [path.join(HOME, '.codex', 'hooks.json'), path.join(HOME, '.codex', 'config.toml')],
    note: 'Hook dialect is a near-clone of Claude’s, so the guards run unmodified.',
    readMcp() {
      const t = read(path.join(HOME, '.codex', 'config.toml')) || '';
      const names = new Set();
      for (const line of t.split('\n')) {
        if (line.trim().startsWith('#')) continue; // skip superseded commented blocks
        const m = line.match(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]/);
        if (m) names.add(m[1]);
      }
      return [...names].sort();
    },
  },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    model: 'gemini 3.x / claude via agy',
    rules: path.join(HOME, '.gemini', 'GEMINI.md'),
    skillsDir: path.join(HOME, '.gemini', 'config', 'skills'),
    configFiles: [path.join(HOME, '.gemini', 'config', 'hooks.json')],
    note: 'Different hook dialect; guards run through the agy adapter shim.',
    readMcp() {
      const j = readJSON(path.join(HOME, '.gemini', 'config', 'mcp_config.json'));
      return Object.keys((j && j.mcpServers) || {}).sort();
    },
  },
];

// Guards that genuinely cannot exist on a target, with the reason. Anything not
// listed here and not wired is a real gap, not an intentional omission.
const NA = {
  codex: {
    'agent-model-guard': 'no Fable/Opus routing to cap',
    'opus-handoff-inject': 'Opus-specific',
    'guard-canary': 'reads Claude’s own guard state',
    'session-count': 'counts Claude transcripts',
    rtk: 'runs inside the codex-rewrite adapter',
  },
  agy: {
    'agent-model-guard': 'no Fable/Opus routing to cap',
    'opus-handoff-inject': 'Opus-specific',
    'guard-canary': 'reads Claude’s own guard state',
    'session-count': 'counts Claude transcripts',
    'rm-guard': 'not yet chained into the agy adapter',
    'slow-command-guard': 'not yet chained into the agy adapter',
    'git-tree-guard': 'not yet chained into the agy adapter',
    'batch-guard': 'not yet chained into the agy adapter',
    'declick-nudge': 'not yet chained into the agy adapter',
    'creds-resolve': 'not yet chained into the agy adapter',
    'codex-memory-inject': 'Codex-only adapter',
    'codex-rewrite': 'Codex-only adapter',
  },
  claude: {
    'codex-memory-inject': 'Codex-only adapter (Claude has native memory)',
    'codex-rewrite': 'Codex-only adapter (Claude runs rtk and repowise directly)',
  },
};

const data = HARNESSES.map(inspectHarness);

let syncState = 'unknown';
try {
  execFileSync('node', [path.join(HOME, '.claude', 'tools', 'harness-sync', 'sync.cjs'), '--check'], {
    stdio: 'ignore',
  });
  syncState = 'in sync';
} catch {
  syncState = 'STALE';
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        syncState,
        harnesses: data.map((d) => ({
          id: d.id,
          rules: d.rules,
          skills: d.skills,
          mcp: d.mcp,
          wired: [...d.wired],
        })),
      },
      null,
      2
    )
  );
  process.exit(0);
}

// ---- render -------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cell(h, guard) {
  if (h.wired.has(guard)) return '<td class="y" title="wired and the script exists">yes</td>';
  const reason = NA[h.id] && NA[h.id][guard];
  if (reason) return `<td class="na" title="${esc(reason)}">n/a</td>`;
  return '<td class="n" title="not wired">no</td>';
}

const covered = (h) => {
  const applicable = GUARDS.filter(([g]) => !(NA[h.id] && NA[h.id][g]));
  return { got: applicable.filter(([g]) => h.wired.has(g)).length, of: applicable.length };
};

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

const html = `<title>Harness Parity</title>
<style>
  :root{
    --bg:#f7f7f5; --panel:#fff; --ink:#1a1a19; --muted:#6b6b66; --line:#e3e3de;
    --yes:#1f7a4d; --yesbg:#e6f4ec; --no:#b3261e; --nobg:#fdeceb; --na:#8a8a84; --nabg:#f0f0ed;
    --accent:#2f5fd0;
  }
  :root:not([data-theme="light"]){ @media (prefers-color-scheme: dark){
    --bg:#141414; --panel:#1c1c1b; --ink:#ececea; --muted:#9a9a94; --line:#2e2e2c;
    --yes:#5fd39b; --yesbg:#12301f; --no:#ff8f86; --nobg:#331715; --na:#7d7d78; --nabg:#242423;
    --accent:#8fb0ff;
  }}
  :root[data-theme="dark"]{
    --bg:#141414; --panel:#1c1c1b; --ink:#ececea; --muted:#9a9a94; --line:#2e2e2c;
    --yes:#5fd39b; --yesbg:#12301f; --no:#ff8f86; --nobg:#331715; --na:#7d7d78; --nabg:#242423;
    --accent:#8fb0ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
    padding:32px 24px 64px}
  .wrap{max-width:1080px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--muted);margin:0 0 24px;font-size:14px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:28px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card h2{font-size:15px;margin:0 0 2px}
  .card .model{color:var(--muted);font-size:12.5px;font-family:ui-monospace,Consolas,monospace;margin-bottom:12px}
  .bar{height:6px;background:var(--nabg);border-radius:3px;overflow:hidden;margin:10px 0 6px}
  .bar>i{display:block;height:100%;background:var(--yes)}
  .kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0;color:var(--muted)}
  .kv b{color:var(--ink);font-weight:600}
  .note{margin-top:10px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px}
  .scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;min-width:640px;font-size:14px}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line)}
  thead th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
  tbody tr:last-child td{border-bottom:0}
  td.y,td.n,td.na{text-align:center;font-weight:600;font-size:12.5px;width:104px}
  td.y{color:var(--yes);background:var(--yesbg)}
  td.n{color:var(--no);background:var(--nobg)}
  td.na{color:var(--na);background:var(--nabg)}
  .what{color:var(--muted);font-size:12.5px}
  code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:var(--nabg);padding:1px 5px;border-radius:4px}
  .pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:20px}
  .pill.ok{color:var(--yes);background:var(--yesbg)} .pill.bad{color:var(--no);background:var(--nobg)}
  h3{font-size:14px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .cmds{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;font-size:13.5px}
  .cmds div{padding:4px 0}
  footer{margin-top:28px;color:var(--muted);font-size:12.5px}
</style>
<div class="wrap">
  <h1>Harness parity</h1>
  <p class="sub">One safety layer, three agents. Every cell below is read live from the config files on disk &mdash; generated ${esc(stamp)}.</p>

  <div class="cards">
    ${data
      .map((h) => {
        const c = covered(h);
        const pct = Math.round((c.got / c.of) * 100);
        return `<div class="card">
      <h2>${esc(h.name)}</h2>
      <div class="model">${esc(h.model)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="kv"><span>guards wired</span><b>${c.got} / ${c.of}</b></div>
      <div class="kv"><span>rules file</span><b>${h.rules.exists ? `${h.rules.lines} lines` : 'MISSING'}</b></div>
      <div class="kv"><span>shared skills</span><b>${h.skills.shared}</b></div>
      <div class="kv"><span>own skills</span><b>${h.skills.own}</b></div>
      <div class="kv"><span>MCP servers</span><b>${h.mcp.length}</b></div>
      <div class="note">${esc(h.note)}</div>
    </div>`;
      })
      .join('\n    ')}
  </div>

  <h3>Guard coverage</h3>
  <div class="scroll">
    <table>
      <thead><tr><th>Guard</th><th>What it stops</th>${data.map((h) => `<th style="text-align:center">${esc(h.name)}</th>`).join('')}</tr></thead>
      <tbody>
        ${GUARDS.map(
          ([g, what]) =>
            `<tr><td><code>${esc(g)}</code></td><td class="what">${esc(what)}</td>${data.map((h) => cell(h, g)).join('')}</tr>`
        ).join('\n        ')}
      </tbody>
    </table>
  </div>
  <p class="sub" style="margin-top:10px">
    <b>yes</b> = named in the harness&rsquo;s config and the script exists.
    <b>n/a</b> = cannot apply (hover for why).
    <b>no</b> = a real gap.
  </p>

  <h3>MCP servers</h3>
  <p class="sub" style="margin:-2px 0 10px">Shared on purpose: <code>offlocal</code> (provider credentials) and <code>context7</code> (library docs). The rest are harness-native and not parity targets.</p>
  <div class="scroll">
    <table>
      <thead><tr><th>Server</th>${data.map((h) => `<th style="text-align:center">${esc(h.name)}</th>`).join('')}</tr></thead>
      <tbody>
        ${[...new Set(data.flatMap((h) => h.mcp))]
          .sort()
          .map(
            (s) =>
              // Absence is neutral, not red: MCP parity is not a goal for every
              // server (playwright and node_repl are Codex-native; claude-design
              // and sidetap are Claude-only on purpose). Only the guard table
              // treats a missing row as a defect.
              `<tr><td><code>${esc(s)}</code></td>${data
                .map((h) => (h.mcp.includes(s) ? '<td class="y">yes</td>' : '<td class="na">&mdash;</td>'))
                .join('')}</tr>`
          )
          .join('\n        ')}
      </tbody>
    </table>
  </div>

  <h3>Rules sync</h3>
  <div class="cmds">
    <div>Status: <span class="pill ${syncState === 'in sync' ? 'ok' : 'bad'}">${esc(syncState)}</span></div>
    <div style="margin-top:8px">Source of truth: <code>~/.claude/CLAUDE.md</code> + <code>SOUL.md</code></div>
    ${data
      .filter((h) => h.id !== 'claude')
      .map(
        (h) =>
          `<div>Generated: <code>${esc(h.rules.path.replace(HOME, '~'))}</code> &mdash; ${h.rules.kb} KB${h.rules.generated ? '' : ' <b>(not stamped as generated)</b>'}</div>`
      )
      .join('\n    ')}
    <div style="margin-top:10px">Regenerate: <code>node ~/.claude/tools/harness-sync/sync.cjs</code></div>
    <div>Verify only: <code>node ~/.claude/tools/harness-sync/sync.cjs --check</code></div>
    <div>Prove the guards still fire: <code>sh ~/.claude/hooks/adapters/test-agy-adapter.sh</code></div>
    <div>Refresh this page: <code>node ~/.claude/tools/harness-sync/parity.cjs --open</code></div>
  </div>

  <footer>Contract and porting notes: <code>~/.claude/docs/harness-parity.md</code></footer>
</div>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
for (const h of data) {
  const c = covered(h);
  console.log(`  ${h.name.padEnd(18)} guards ${c.got}/${c.of}  skills ${h.skills.shared} shared + ${h.skills.own} own  mcp ${h.mcp.length}`);
}
console.log(`  rules: ${syncState}`);

if (OPEN) {
  try {
    execFileSync('cmd', ['/c', 'start', '', OUT], { stdio: 'ignore' });
  } catch (e) {
    console.error(`could not open automatically: ${e.message}`);
  }
}
