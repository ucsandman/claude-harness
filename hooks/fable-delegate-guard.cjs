#!/usr/bin/env node
/**
 * engine/hooks/fable-delegate-guard.cjs — delegation briefing and hand-work log
 * for a Fable main loop (Claude Code PreToolUse + UserPromptSubmit + SessionStart).
 *
 * Fable is the expensive model. When it runs the main loop it should spend its
 * tokens on decisions, review and synthesis, and hand large hands-on work to
 * subagents (Agent tool with an explicit model, or a Workflow). This hook
 * briefs the session once with the measured token economics and logs the
 * hand-work the loop does anyway (large edits, code-writing shell commands),
 * so `--report` shows how much of it there is. It denies nothing.
 *
 * It used to enforce: a per-prompt edit budget and a shell code-writing denial.
 * Retired 2026-09-06 after reading its own log: 1,046 events, 714 of them
 * `# FABLE_OK` overrides, 266 shell denials (among them `npm test`, a heredoc
 * commit message and a read-only grep), 47 edit denials that arrived in runs
 * of five to seven on the same file because the model treats a deny like a
 * transient error and retries the next queued edit. The 2026-09-03 declick
 * launch had already shown the other side: three delegated fix passes cost
 * 3.7M tokens and two hours on defects a 40-minute hand pass closed, and the
 * budget fought that hand pass. A cap that fires at edit 21 of a coherent
 * change set leaves a half-edited file, which neither finishing nor never
 * starting would have done. The briefing was the part that informed the
 * routing decision; the block only produced probing.
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
 * `isMutatingShell` is the shared shell classifier; the Codex twin
 * (~/.claude/hooks/adapters/codex-delegate-guard.cjs) requires it from here.
 *
 * Silence the briefing for a session: FABLE_DELEGATE_GUARD=off.
 * Report: node fable-delegate-guard.cjs --report
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Old override marker. No longer needed; still stripped so an annotated command classifies the same.
const MARKER = /#\s*FABLE_OK:\s*([^\n]*)/i;
const MAX_MARK_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;

// "Large" is what the retired budget called a non-small edit. It is a log
// threshold now, so the report can separate fix-ups from typed features.
const LARGE_EDIT_LINES = 160;
const LARGE_WRITE_LINES = 200;

const INJECTION = '[fable-delegate-guard] This session runs on Fable. Token economics (measured 2026-09-02): a subagent costs ~60k input tokens before its first tool call (harness prompt + skill/tool catalogs), then 2-4k per call. Anything under ~10 tool calls or ~80 lines of edits is CHEAPER done here than delegated; a one-line edit handed to Sonnet cost 77k, and on 2026-09-03 three delegated fix passes cost 3.7M tokens on defects a 40-minute hand pass closed. Delegate only large work (many files, a test suite, long tool output, or independent pieces that run in parallel) and name the model explicitly: opus large/risky, sonnet mid-size, haiku lookups. Nothing is enforced: edit directly when that is cheaper, and finish a change set you started rather than leaving a file half-edited. Large edits and code-writing shell commands are logged for `--report`. Fable keeps decisions, final review, and synthesis.';

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

// A mutating word must stand as its own token: `--no-patch`, `dotnet-rm` and
// `foo.patch` are not commands (2026-09-05: `git show --no-patch` was denied in a
// real Codex session through the shared classifier).
const MUTATING_WORDS = /(?<![-\w.\/])(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|patch|truncate|tee)\b/i;
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
  // A redirect to a shell variable cannot be resolved here; when the command itself names the scratchpad
  // (L="<scratchpad>/x.log"; npm test > "$L"), the variable is that path, and the run is a read plus a log.
  const namesScratch = roots.filter(Boolean).some((r) => norm(cmd).includes(norm(r)));
  while ((m = REDIRECT.exec(scan)) !== null) {
    const target = m[2].replace(/^['"]|['"]$/g, '');
    if (target.startsWith('$') && namesScratch) continue;
    if (!underAny(target, roots)) return true;
  }

  // Mutations whose every named path lands in the scratchpad or tmp are not
  // hands-on code: a sed -i on a probe script or an inline node writer of a
  // temp file.
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

// --- classification (log only) ----------------------------------------------

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

function isSmallEdit(tool, input) {
  if (tool === 'Write') return lines(input.content) <= LARGE_WRITE_LINES;
  if (tool === 'Edit') return lines(input.new_string) <= LARGE_EDIT_LINES;
  if (tool === 'NotebookEdit') return lines(input.new_source) <= LARGE_EDIT_LINES;
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.length > 0 && edits.length <= 3 && edits.every(e => lines(e && e.new_string) <= LARGE_EDIT_LINES);
  }
  return false;
}

// Every verdict allows. `kind` says what the guard saw; large edits and
// code-writing shell commands outside ~/.claude, the scratchpad and tmp are
// logged so `--report` can show how much hand-work a Fable loop does.
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
  const note = (kind, detail) => {
    logEvent({
      ts: new Date().toISOString(),
      session_id: payload.session_id || null,
      tool_name: tool,
      kind,
      detail: String(detail).slice(0, 160),
      ...(payload.agent_type ? { agent_type: payload.agent_type } : {})
    }, opts);
    return { action: 'allow', kind, reason: '', model };
  };

  if (EDIT_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || '';
    if (allowedEditPath(payload, opts, target)) {
      return { action: 'allow', kind: 'allowed-path', reason: '', model };
    }
    if (isSmallEdit(tool, input)) return { action: 'allow', kind: 'small-edit', reason: '', model };
    return note('large-edit', target);
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = String(input.command || '');
    if (!isMutatingShell(command, { tmpdir: opts.tmpdir, scratchpad: payload.scratchpad_dir, cwd: payload.cwd })) {
      return { action: 'allow', kind: 'allowed-shell', reason: '', model };
    }
    return note('shell-write', command);
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
    decide(payload, opts); // log only; PreToolUse has no model-visible channel short of a deny
    return '';
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
    const day = String(e.ts || '').slice(0, 10) || 'undated';
    const bucket = days[day] || (days[day] = {});
    bucket[e.kind] = (bucket[e.kind] || 0) + 1;
  }
  console.log(`fable-delegate-guard: ${lines.length} events logged (deny-* and override are from before 2026-09-06, when the guard still blocked)`);
  for (const d of Object.keys(days).sort()) {
    const parts = Object.keys(days[d]).sort().map((k) => `${k}=${days[d][k]}`).join('  ');
    console.log(`  ${d}  ${parts}`);
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
