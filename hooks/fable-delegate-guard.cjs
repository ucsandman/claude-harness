#!/usr/bin/env node
/**
 * engine/hooks/fable-delegate-guard.cjs — delegate-first enforcement for a
 * Fable main loop (Claude Code PreToolUse + UserPromptSubmit + SessionStart).
 *
 * Fable is the expensive model. When it runs the main loop it should spend its
 * tokens on decisions, review and synthesis, and hand the hands-on work to
 * subagents (Agent tool with an explicit model, or a Workflow). This hook makes
 * that mechanical instead of aspirational: while the session model is Fable,
 * writing code through the shell is denied, and direct edits outside ~/.claude
 * and the session scratchpad are a budget rather than a wall — up to 3 small
 * edits per prompt for fix-ups, anything bigger goes to a subagent.
 *
 * Model detection (no PreToolUse payload field carries the model — measured
 * 2026-09-02): payload.model (SessionStart only) -> newest assistant
 * message.model in the transcript tail -> per-session cache file -> the
 * persisted "model" key in ~/.claude/settings.json.
 *
 * Subagents are exempt. A subagent's payload carries `agent_id` / `agent_type`
 * while `transcript_path` still points at the MAIN transcript, so `agent_id` is
 * the only sound signal — never infer subagent-ness from the transcript path.
 *
 * Known escape hatch, deliberately left open: running a script by path
 * (`node do-it.js`, `python fix.py`) is allowed, because the alternative is
 * denying every test and lint invocation. The guard raises the cost of casual
 * hands-on work in the main loop; it is not a sandbox.
 *
 * Override one shell command: append `# FABLE_OK: <why>` (logged).
 * Disable for a session: FABLE_DELEGATE_GUARD=off.
 * Report: node fable-delegate-guard.cjs --report
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MARKER = /#\s*FABLE_OK:\s*([^\n]*)/i;
const MAX_MARK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;

const DENY_REASON = '[fable-delegate-guard] Delegate-first: this main loop runs on Fable. Hand this work to a subagent: Agent tool with an explicit model (sonnet for implementation, opus for large or risky tasks, haiku for mechanical edits and lookups) or a Workflow; Fable keeps decisions, review, and synthesis. Allowed here: reads, tests and lint, writes under ~/.claude and the session scratchpad. Shell override for a genuinely trivial command: append `# FABLE_OK: <why>` (logged). Disable for one session: set FABLE_DELEGATE_GUARD=off.';

const EDIT_BUDGET = 8;
const SMALL_EDIT_LINES = 80;
const SMALL_WRITE_LINES = 120;

const INJECTION = '[fable-delegate-guard] This session runs on Fable. Token economics (measured 2026-09-02): a subagent costs ~60k input tokens before its first tool call (harness prompt + skill/tool catalogs), then 2-4k per call. Anything under ~10 tool calls or ~80 lines of edits is CHEAPER done here than delegated; a one-line edit handed to Sonnet cost 77k. Delegate only large work (many files, a test suite, long tool output, or independent pieces that run in parallel) and name the model explicitly: opus large/risky, sonnet mid-size, haiku lookups. Enforced budget: 8 direct edits (<=80 lines) or writes (<=120 lines) per prompt; shell writes to ~/.claude and the scratchpad are free; larger code-writing through the shell is denied. Fable keeps decisions, final review, and synthesis.';

function injectionText() {
  return INJECTION;
}

function homeOf(opts) {
  return opts.home || os.homedir();
}
function stateDirOf(opts) {
  return opts.stateDir || path.join(homeOf(opts), '.agnostic', 'fable-delegate-guard');
}
function logPathOf(opts) {
  return opts.logPath || path.join(homeOf(opts), '.agnostic', 'fable-delegate-guard.jsonl');
}
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const isFable = (m) => typeof m === 'string' && /fable/i.test(m);

// Newest assistant message model in a transcript tail (main session or a
// subagent's own transcript — capability-graph-guard reuses this for the
// latter). The first line of the window may be truncated, so it is skipped
// whenever the window is partial. Throws if the file is missing.
function newestAssistantModel(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (start > 0 && i === 0) break;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === 'assistant' && obj.message && obj.message.model) return obj.message.model;
    } catch (_) {}
  }
  return null;
}

function sessionModel(payload = {}, opts = {}) {
  if (opts.model) return opts.model; // test / caller override
  const cache = payload.session_id
    ? path.join(stateDirOf(opts), `${payload.session_id}.model`)
    : null;

  const remember = (model) => {
    if (cache && model) {
      try {
        fs.mkdirSync(path.dirname(cache), { recursive: true });
        fs.writeFileSync(cache, model, 'utf8');
      } catch (_) {}
    }
    return model;
  };

  if (payload.model) return remember(payload.model);
  if (payload.transcript_path) {
    try {
      const m = newestAssistantModel(payload.transcript_path);
      if (m) return remember(m);
    } catch (_) {}
  }
  if (cache) {
    try {
      const m = fs.readFileSync(cache, 'utf8').trim();
      if (m) return m;
    } catch (_) {}
  }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(homeOf(opts), '.claude', 'settings.json'), 'utf8')).model;
    if (m) return m;
  } catch (_) {}
  return null;
}

// --- shell mutation detection ------------------------------------------------

const MUTATING_WORDS = /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|patch|truncate|tee)\b/i;
const SED_INPLACE = /\bsed\s+(-[a-z]*\s+)*-[a-z]*i\b/i;
// git and package installs are deliberately NOT here: committing, pushing and
// installing are operator acts, not hands-on code writing, and guards.json
// already hard-stops the destructive git forms.
const PS_MUTATE = /\b(Set-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Add-Content|Rename-Item|Clear-Content)\b/i;
const INLINE_SRC = /(python3?|node)\s+(-c|-e)\s+([\s\S]+)$/i;
const INLINE_WRITE = /(write_text|writeFileSync|appendFileSync|unlink|rename|mkdir|open\s*\([^)]*,\s*['"][rwabt+]*[wa][rwabt+]*['"])/i;
// Redirections that write nowhere real, stripped before the redirection scan.
const NOISE_REDIR = /(\d?>&\d|[12&]?>>?\s*(\/dev\/null|nul\b))/gi;
const REDIRECT = /(^|[^&\w>-])[0-9]?>>?\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;

function underAny(target, roots) {
  const t = norm(target);
  return roots.filter(Boolean).some((r) => {
    const root = norm(r);
    return root && (t === root || t.startsWith(root + '/'));
  });
}

function isMutatingShell(command, opts = {}) {
  let cmd = String(command || '').replace(MARKER, ' ');
  if (!cmd.trim()) return false;

  if (/<</.test(cmd)) return true;              // heredoc: how inline scripts write files
  if (/\|\s*tee\b/i.test(cmd)) return true;

  const roots = [opts.tmpdir || os.tmpdir(), opts.scratchpad];
  const scan = cmd.replace(NOISE_REDIR, ' ');
  let m;
  REDIRECT.lastIndex = 0;
  while ((m = REDIRECT.exec(scan)) !== null) {
    const target = m[2].replace(/^['"]|['"]$/g, '');
    if (!underAny(target, roots)) return true;
  }

  // Mutations whose every named path lands in the scratchpad or tmp are free:
  // a sed -i on a probe script or an inline node writer of a temp file is not
  // hands-on code, and delegating it costs a ~60k-token subagent spawn.
  const scratchOnly = onlyUnderRoots(cmd, roots, opts.cwd);
  if (MUTATING_WORDS.test(cmd) && !scratchOnly) return true;
  if (SED_INPLACE.test(cmd) && !scratchOnly) return true;
  if (PS_MUTATE.test(cmd) && !scratchOnly) return true;

  const inline = cmd.match(INLINE_SRC);
  if (inline && INLINE_WRITE.test(inline[3]) && !scratchOnly) return true;

  return false;
}

// True when the command names at least one path and every path it names is
// under one of the roots. ~, $VAR and /c/ forms are expanded first; relative
// paths resolve against cwd. Conservative: any path outside the roots, or a
// regex that merely looks like a path, makes this false and the command is
// judged by the ordinary rules.
function onlyUnderRoots(cmd, roots, cwd) {
  const expand = (t) => t
    .replace(/^~(?=[\\/]|$)/, os.homedir())
    .replace(/\$\{?(\w+)\}?/g, (_, k) => process.env[k] || '')
    .replace(/^\/([a-z])\//i, (_, d) => `${d}:/`);
  const toks = (cmd.match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) || [])
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => (/\//.test(t) || /\\[^ntr'"\\]/.test(t) || /^~/.test(t)) && !/^-/.test(t) && !/^https?:/.test(t));
  if (!toks.length) return false;
  return toks.every((t) => {
    const p = expand(t);
    const abs = path.isAbsolute(p) || /^[a-z]:/i.test(p) ? p : path.join(cwd || '', p);
    return underAny(abs, roots);
  });
}

// --- decision ----------------------------------------------------------------

function logEvent(entry, opts = {}) {
  try {
    const file = logPathOf(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

function allowedEditPath(payload, opts, target) {
  if (!target) return false;
  const abs = path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target)
    ? target
    : path.resolve(payload.cwd || process.cwd(), target);
  return underAny(abs, [
    path.join(homeOf(opts), '.claude'),
    payload.scratchpad_dir,
    opts.tmpdir || os.tmpdir()
  ]);
}

const lines = (s) => String(s == null ? '' : s).split('\n').length;

// A "small direct edit" is a fix-up Fable may do itself. Anything bigger is
// real implementation work and belongs to a subagent.
function isSmallEdit(tool, input) {
  if (tool === 'Write') return lines(input.content) <= SMALL_WRITE_LINES;
  if (tool === 'Edit') return lines(input.new_string) <= SMALL_EDIT_LINES;
  if (tool === 'NotebookEdit') return lines(input.new_source) <= SMALL_EDIT_LINES;
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.length > 0 && edits.length <= 3 && edits.every(e => lines(e && e.new_string) <= SMALL_EDIT_LINES);
  }
  return false;
}

// Direct edits are budgeted per prompt, so one prompt cannot walk a whole
// refactor through the main loop one small edit at a time.
function editCounterFile(payload, opts) {
  const sid = payload.session_id || 'no-session';
  const name = payload.prompt_id ? `${sid}.${payload.prompt_id}.edits` : `${sid}.edits`;
  return path.join(stateDirOf(opts), name);
}
function editsUsed(payload, opts) {
  try {
    const n = parseInt(fs.readFileSync(editCounterFile(payload, opts), 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}
function bumpEdits(payload, opts, used) {
  try {
    const file = editCounterFile(payload, opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(used + 1), 'utf8');
  } catch (_) {}
}

function decide(payload = {}, opts = {}) {
  const env = opts.env || process.env;
  if (String(env.FABLE_DELEGATE_GUARD || '').toLowerCase() === 'off') {
    return { action: 'allow', kind: 'disabled', reason: '', model: null };
  }
  if (payload.agent_id) {
    return { action: 'allow', kind: 'subagent', reason: '', model: null };
  }

  const model = sessionModel(payload, opts);
  if (!isFable(model)) return { action: 'allow', kind: 'not-fable', reason: '', model };

  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const now = () => new Date(opts.now || Date.now()).toISOString();
  const deny = (kind, detail, extra = '') => {
    logEvent({
      ts: now(),
      session_id: payload.session_id || null,
      tool_name: tool,
      kind,
      detail: String(detail).slice(0, 160),
      ...(payload.agent_type ? { agent_type: payload.agent_type } : {})
    }, opts);
    return {
      action: 'deny',
      kind,
      model,
      reason: `${DENY_REASON} Blocked: ${tool} ${String(detail).slice(0, 120)}.${extra}`
    };
  };

  if (EDIT_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || '';
    if (allowedEditPath(payload, opts, target)) {
      return { action: 'allow', kind: 'allowed-path', reason: '', model };
    }
    const used = editsUsed(payload, opts);
    if (used < EDIT_BUDGET && isSmallEdit(tool, input)) {
      bumpEdits(payload, opts, used);
      return { action: 'allow', kind: 'allowed-small', reason: `${used + 1} of ${EDIT_BUDGET}`, model };
    }
    return deny('deny-edit', target,
      ` Small direct edits (<=${SMALL_EDIT_LINES} lines, ${EDIT_BUDGET} per prompt) are allowed; this prompt has used ${used} of ${EDIT_BUDGET}.`);
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = String(input.command || '');
    if (!isMutatingShell(command, { tmpdir: opts.tmpdir, scratchpad: payload.scratchpad_dir, cwd: payload.cwd })) {
      return { action: 'allow', kind: 'allowed-shell', reason: '', model };
    }
    const marker = command.match(MARKER);
    if (marker) {
      logEvent({
        ts: now(),
        session_id: payload.session_id || null,
        tool_name: tool,
        kind: 'override',
        detail: command.slice(0, 160),
        ...(payload.agent_type ? { agent_type: payload.agent_type } : {})
      }, opts);
      return { action: 'allow', kind: 'override', reason: (marker[1] || '').trim(), model };
    }
    return deny('deny-shell', command);
  }

  return { action: 'allow', kind: 'allowed-path', reason: '', model };
}

// --- session briefing --------------------------------------------------------

function injectOnce(payload, opts) {
  const dir = stateDirOf(opts);
  const mark = path.join(dir, `${payload.session_id}.injected`);
  if (fs.existsSync(mark)) return '';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mark, new Date(opts.now || Date.now()).toISOString(), 'utf8');
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > MAX_MARK_AGE_MS) fs.unlinkSync(fp);
    }
  } catch (_) {}
  return INJECTION;
}

// Returns the text to write to stdout ('' = nothing to say).
function main(payload = {}, opts = {}) {
  const event = payload.hook_event_name || (payload.tool_name ? 'PreToolUse' : '');

  if (event === 'PreToolUse') {
    const verdict = decide(payload, opts);
    if (verdict.action !== 'deny') return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason
      }
    });
  }

  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return '';
  if (!payload.session_id) return '';
  const env = opts.env || process.env;
  if (String(env.FABLE_DELEGATE_GUARD || '').toLowerCase() === 'off') return '';
  if (!isFable(sessionModel(payload, opts))) return '';

  const text = injectOnce(payload, opts);
  if (!text) return '';
  if (event === 'SessionStart') return text; // plain stdout is added to context
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }
  });
}

function report(opts = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(logPathOf(opts), 'utf8').trim().split('\n').filter(Boolean);
  } catch (_) {}
  const days = {};
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    const day = String(e.ts || '').slice(0, 10);
    const bucket = days[day] || (days[day] = { denied: 0, overrides: 0 });
    if (e.kind === 'override') bucket.overrides++; else bucket.denied++;
  }
  console.log(`fable-delegate-guard: ${lines.length} events logged`);
  for (const d of Object.keys(days).sort()) {
    console.log(`  ${d}  denied=${days[d].denied}  overrides=${days[d].overrides}`);
  }
}

if (require.main === module) {
  if (process.argv.includes('--report')) {
    report();
    process.exit(0);
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buffer += chunk; });
  process.stdin.on('end', () => {
    try {
      const out = main(buffer.trim() ? JSON.parse(buffer) : {});
      if (out) process.stdout.write(out);
    } catch (err) {
      // Fail open: never block a session on a guard bug, but leave a trace.
      logEvent({ ts: new Date().toISOString(), kind: 'error', detail: String(err && err.message).slice(0, 160) });
    }
    process.exit(0);
  });
}

module.exports = { decide, sessionModel, newestAssistantModel, isMutatingShell, injectionText, main };
