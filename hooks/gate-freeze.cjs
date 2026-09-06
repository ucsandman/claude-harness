#!/usr/bin/env node
// gate-freeze.cjs — PreToolUse [Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell]
// A session working on a project cannot edit the guards that judge it. The frozen fileset is
// tools/gates/gate-manifest.json (hooks, the pre-commit chain, the gates runner, the wire-dark
// checker, the hooks section of settings.json, the agnostic-ai and DashClaw guard scripts).
// A write to one of them is allowed only when the session's cwd is inside a harness root; from
// anywhere else it is denied, and so is `gates.cjs --lock`, the relock. The hash check in
// gates.cjs (`gate-freeze`, run by guard-canary and the harness pre-commit) catches what this
// hook cannot see: Codex, hand edits, and a session that ran with the guard off.
// Override for one shell command: `# GATE_OK: <why>` (logged). Off for a session: GATE_FREEZE=off.
// Ported from ELAI's gate_freeze_check (rule R8), 2026-09-06.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const freeze = require(path.join(__dirname, '..', 'tools', 'gates', 'freeze.cjs'));

const OK = /GATE_OK:/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'apply_patch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
const WRITE_VERB = /(^|[^&\w>-])[0-9]?>>?\s*(?!(\/dev\/null|nul\b|&))|\bsed\s+(-\w*i|--in-place)|\btee\b|\b(Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|Remove-Item|Rename-Item|New-Item)\b|\b(cp|mv|rm|truncate|install|ln)\s|\bperl\s+-\w*i|open\([^)]*['"][wa]/i;
const SETTINGS_HOOK_TOUCH = /"(hooks|matcher|command|statusMessage)"|\.(cjs|ps1|py)["']/;

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
function log(kind, what) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'logs'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gate-freeze.log'), `${new Date().toISOString()}\t${kind}\t${String(what).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch { /* best effort */ }
}
const REASON = (what) => `[gate-freeze] ${what} is a frozen guard (tools/gates/gate-manifest.json) and this session's cwd is outside every harness root. A run does not edit the evaluator that judges it. Do the guard work from a session opened in ~/.claude (or another harness root), then relock with \`node tools/gates/gates.cjs --lock\`. Shell override for one command: \`# GATE_OK: <why>\`; session off switch: GATE_FREEZE=off.`;

// Exported for the probe: returns a deny reason or null.
function judge(input) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  if (freeze.inHarnessRoot(cwd)) return null;
  if (EDIT_TOOLS.has(tool)) {
    if (tool === 'apply_patch') {
      const patch = String(ti.command || ti.patch || '');
      if (OK.test(patch)) return null;
      const touched = [...patch.matchAll(/^\*\*\* (?:Update|Delete|Add) File: (.+)$/gm)].map((m) => m[1].trim());
      const hit = touched.map((p) => freeze.frozenEntryFor(p, cwd)).find(Boolean);
      return hit ? REASON(hit.abs) : null;
    }
    const fp = String(ti.file_path || ti.path || ti.notebook_path || '');
    if (!fp) return null;
    const entry = freeze.frozenEntryFor(fp, cwd);
    if (!entry) return null;
    if (entry.key) {
      // settings.json: only the hooks section is frozen; a permissions edit passes.
      const text = [ti.old_string, ti.new_string, ti.content, ...(ti.edits || []).flatMap((e) => [e.old_string, e.new_string])].filter(Boolean).join('\n');
      if (!SETTINGS_HOOK_TOUCH.test(text)) return null;
      return REASON(`${path.basename(entry.abs)} (${entry.key} section)`);
    }
    return REASON(entry.abs);
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command || '');
    if (!cmd.trim() || OK.test(cmd)) { if (OK.test(cmd)) log('override', cmd); return null; }
    if (/gates\.cjs\b[^\n;&|]*--lock/.test(cmd)) return REASON('the relock (gates.cjs --lock)');
    if (!WRITE_VERB.test(cmd)) return null;
    const names = new Set(freeze.frozenFiles().map((f) => path.basename(f.abs)));
    const mentioned = [...names].filter((n) => cmd.includes(n));
    if (!mentioned.length) return null;
    // `settings.json` is only frozen for its hooks key; a shell write to it is opaque, so it counts.
    return REASON(mentioned.join(', '));
  }
  return null;
}

if (require.main === module) {
  if (/^(off|0|false)$/i.test(process.env.GATE_FREEZE || '')) process.exit(0);
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  let reason = null;
  try { reason = judge(input); } catch (e) { log('error', e.message); process.exit(0); }
  if (reason) { log('deny', `${input.tool_name} ${JSON.stringify(input.tool_input || {}).slice(0, 200)}`); deny(reason); }
  process.exit(0);
}
module.exports = { judge };
