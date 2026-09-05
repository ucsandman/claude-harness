#!/usr/bin/env node
// rm-guard.cjs - PreToolUse [Bash|PowerShell]
// Denies recursive deletes whose target is not disposable. The permission list only sees a command that STARTS with
// rm, so `cd build; rm -rf .` and `Get-ChildItem x | Remove-Item -Recurse` never match it; this hook splits on shell
// separators and checks every segment (pattern borrowed from jde-projects.com/ai-setup, adopted 2026-09-03).
// Disposable = every target lives in the session scratchpad (Temp\claude) or has a build/cache directory in its path
// (node_modules, dist, build, .next, out, coverage, __pycache__, ...). Anything else is a hard stop under the global
// rules ("deleting files"), so it needs the operator's yes: append `# RM_OK: <why>` after confirmation.
// Fails loud: unparseable input is a pass-through (nothing to judge), but a delete whose targets cannot be read
// (a pipeline, a variable) is denied, never assumed safe.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'shell_command', 'run_command']);
const OK = /RM_OK:/;
const SAFE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'out', 'coverage', '__pycache__', '.turbo',
  '.cache', '.pytest_cache', '.parcel-cache', '.nuxt', '.svelte-kit', 'tmp', '.tmp', 'target', '.venv-tmp']);
const SCRATCH = /Temp[\\/]claude|scratchpad/i;

// One segment = one command in command position. Split on ; && || | and newlines, outside quotes is good enough here:
// a false split inside a quoted string only yields a segment that fails the command-word test.
function segments(cmd) {
  return cmd.split(/\s*(?:;|&&|\|\||\||\n|\r\n)\s*/).map(s => s.trim()).filter(Boolean);
}
function stripWrappers(seg) {
  return seg.replace(/^\(+\s*/, '').replace(/^(?:(?:sudo|env|nice|time)\s+)+/, '').replace(/^(?:\S+=\S*\s+)+/, '');
}
function words(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Returns null when the segment is not a recursive delete, else {targets: string[]}.
function recursiveDelete(seg) {
  const w = words(stripWrappers(seg));
  if (!w.length) return null;
  const cmd = path.basename(w[0]).toLowerCase().replace(/\.exe$/, '');
  const rest = w.slice(1);
  const lower = rest.map(x => x.toLowerCase());
  const targetsOf = (skipAfter) => rest.filter((x, i) => {
    if (x.startsWith('-') || /^\/[sq]$/i.test(x)) return false;
    if (i > 0 && skipAfter.has(lower[i - 1])) return false; // value of -Path / -LiteralPath / -Include
    return true;
  });
  if (cmd === 'rm') {
    // bash rm: recursive when a short flag cluster carries r/R or --recursive; PowerShell alias rm: -Recurse
    const rec = rest.some(x => /^-[a-zA-Z]*[rR]/.test(x) && !/^-[a-zA-Z]*e/.test(x) && x !== '-Recurse') ||
      lower.includes('--recursive') || lower.some(x => x.startsWith('-recurse'));
    if (!rec) return null;
    return { targets: targetsOf(new Set(['-include', '-exclude', '-filter'])) };
  }
  if (['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'].includes(cmd)) {
    const rec = lower.some(x => x.startsWith('-recurse')) || lower.includes('/s') || cmd === 'rmdir' && lower.includes('-r');
    if (cmd === 'rmdir' && !rec && !lower.includes('/s')) return null; // plain rmdir only removes an empty dir
    if (!rec) return null;
    return { targets: targetsOf(new Set(['-path', '-literalpath', '-include', '-exclude', '-filter'])) };
  }
  return null;
}
function disposable(target) {
  if (SCRATCH.test(target)) return true;
  const segs = target.replace(/^["']|["']$/g, '').split(/[\\/]+/).filter(Boolean);
  if (segs.includes('..')) return false;
  return segs.some(s => SAFE_DIRS.has(s.toLowerCase()));
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
function logHit(kind, cmd) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'rm-guard.log'), new Date().toISOString() + '\t' + kind + '\t' + cmd.replace(/\s+/g, ' ').slice(0, 300) + '\n');
  } catch {}
}

if (require.main === module) {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (input.tool_name === 'apply_patch') {
    const patch = String((input.tool_input || {}).command || '');
    const deleted = [...patch.matchAll(/^\*\*\* Delete File: (.+)$/gm)].map(m => m[1].trim());
    const outside = deleted.filter(p => !disposable(path.resolve(input.cwd || process.cwd(), p)));
    if (outside.length && !OK.test(patch)) {
      logHit('deny-patch', outside.join(' '));
      deny('[rm-guard] Patch deletes non-disposable files: ' + outside.join(', ') + '. Obtain explicit operator confirmation before deletion; use the documented RM_OK marker after confirmation.');
    }
    process.exit(0);
  }
  if (!SHELL_TOOLS.has(input.tool_name || '')) process.exit(0);
  const cmd = String((input.tool_input || {}).command || '');
  if (!cmd.trim()) process.exit(0);
  if (OK.test(cmd)) { logHit('override', cmd); process.exit(0); }
  for (const seg of segments(cmd)) {
    const hit = recursiveDelete(seg);
    if (!hit) continue;
    if (hit.targets.length && hit.targets.every(disposable)) continue;
    const what = hit.targets.length ? hit.targets.join(' ') : '(no literal target: pipeline or variable)';
    logHit('deny', seg);
    deny(`[rm-guard] recursive delete of ${what} is a hard stop (global rules: deleting files). Disposable targets pass on their own: the session scratchpad, or a path containing node_modules/dist/build/.next/out/coverage/__pycache__/.cache/tmp. For anything else, get Wes's yes for this exact path, then append \`# RM_OK: <why>\`.`);
    process.exit(0);
  }
  process.exit(0);
}
module.exports = { recursiveDelete, disposable, segments };
