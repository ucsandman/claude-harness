#!/usr/bin/env node
/*
 * secret-guard.cjs — Claude Code PreToolUse hook (Node.js / CommonJS)
 *
 * WHAT IT DOES
 *   Blocks tool calls that would write a real, high-confidence secret into the
 *   repo (or commit one via Bash), while staying out of the way of normal work.
 *
 *   Scanned tools:
 *     - Write      -> scans tool_input.content;            path = tool_input.file_path
 *     - Edit       -> scans tool_input.new_string;         path = tool_input.file_path
 *     - MultiEdit  -> scans each tool_input.edits[].new_string; path = tool_input.file_path
 *     - Bash       -> scans tool_input.command (e.g. "git add .env", inline exports)
 *     - anything else -> allow (no output, exit 0)
 *
 *   On a real hit, it emits the documented PreToolUse "deny" decision on stdout
 *   (hookSpecificOutput.permissionDecision = "deny") and NEVER echoes the secret
 *   value back — only the matched pattern type and the target file.
 *
 * FALSE-POSITIVE GUARDS (must not block legitimate work)
 *   - Real env files (.env, .env.local, .env.<anything-but-example>) ALLOW: secrets
 *     legitimately live there. Example/sample/template env files are still scanned
 *     (they must hold placeholders only).
 *   - A match is skipped if its surrounding line contains an obvious placeholder
 *     marker (YOUR_, EXAMPLE, PLACEHOLDER, REDACTED, CHANGEME, xxxx, <, >, ***,
 *     dummy, fake, test_).
 *
 * FAIL-OPEN BY DESIGN
 *   Everything is wrapped in try/catch. On ANY parse or internal error we ALLOW
 *   (exit 0) and write a single diagnostic line to stderr. A bug in this guard
 *   must never block all of the user's edits — security tooling that breaks the
 *   editor is worse than the leak it was meant to prevent. The trade-off here is
 *   deliberate: prefer a missed scan over a wedged workflow.
 *
 * OUTPUT SHAPE (verified against https://code.claude.com/docs/en/hooks)
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "PreToolUse",
 *       "permissionDecision": "deny",
 *       "permissionDecisionReason": "<human-readable, no secret value>"
 *     }
 *   }
 *   Exit 0 with this JSON on stdout = the decision is honored. No output + exit 0
 *   = no decision, normal permission flow proceeds.
 */

'use strict';

// --- High-confidence secret patterns -------------------------------------
// Each entry: { type, re }. `type` is what we name in the deny reason.
const SECRET_PATTERNS = [
  // OpenAI project keys must be tried before the generic sk- rule.
  { type: 'OpenAI project key', re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { type: 'OpenAI API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { type: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { type: 'DashClaw live key', re: /oc_live_[0-9a-f]{16,}/ },
  { type: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { type: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { type: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { type: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { type: 'Stripe live secret key', re: /sk_live_[0-9a-zA-Z]{20,}/ },
  { type: 'Stripe live restricted key', re: /rk_live_[0-9a-zA-Z]{20,}/ },
  { type: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Conservative generic rule: an assignment of a long quoted value to a
// secret-named field, e.g.  api_key = "abcd...20+chars".
const GENERIC_RE =
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]([^'"]{20,})['"]/i;

// Placeholder markers — if any appear on the matched line, skip the match.
const PLACEHOLDER_MARKERS = [
  'your_', 'example', 'placeholder', 'redacted', 'changeme',
  'xxxx', '<', '>', '***', 'dummy', 'fake', 'test_',
];

function lineHasPlaceholder(line) {
  const lower = line.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => lower.includes(m));
}

// Return the full line of `text` that contains character offset `idx`.
function lineAt(text, idx) {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  let end = text.indexOf('\n', idx);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

// Does the value look high-entropy enough to be a real generic secret?
// Heuristic: mixes character classes and isn't a single repeated run.
function looksHighEntropy(value) {
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);
  const classes =
    (hasLower ? 1 : 0) + (hasUpper ? 1 : 0) +
    (hasDigit ? 1 : 0) + (hasSymbol ? 1 : 0);
  const distinct = new Set(value).size;
  // At least two character classes and reasonable variety of distinct chars.
  return classes >= 2 && distinct >= 8;
}

// Scan text; return the first matched pattern type, or null if clean.
function scanForSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  for (const { type, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const line = lineAt(text, m.index);
      if (!lineHasPlaceholder(line)) return type;
    }
  }

  // Generic assignment rule — scan line by line so placeholder guard is local.
  const g = GENERIC_RE.exec(text);
  if (g) {
    const line = lineAt(text, g.index);
    const value = g[2];
    if (!lineHasPlaceholder(line) && looksHighEntropy(value)) {
      return 'generic high-entropy secret assignment';
    }
  }

  return null;
}

// Decide whether the target path is a real env file we should NOT scan.
// .env, .env.local, .env.<x> are allowed; .env.example/.sample/.template are scanned.
function isRealEnvFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const base = filePath.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (base === '.env' || base === '.env.local') return true;
  if (base.startsWith('.env.')) {
    const suffix = base.slice('.env.'.length);
    const scannedSuffixes = ['example', 'sample', 'template'];
    if (scannedSuffixes.includes(suffix)) return false; // scan these
    return true; // any other .env.<x> (e.g. .env.production) -> real env file
  }
  return false;
}

// Detect a Bash command that stages a real .env file by name, e.g.
// "git add .env" or "git add .env.production". Example/sample/template env
// files are meant to be committed, so they're not flagged. Returns the
// matched file name, or null. Deliberately narrow: only the explicit
// `git add <path>` staging case (broad globs like `git add .` are out of scope).
function gitAddsRealEnvFile(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  // Split on shell separators so each `git add ...` segment is checked alone.
  const segments = command.split(/&&|\|\||;|\||\n/);
  for (const seg of segments) {
    const m = /\bgit\s+add\b([^&|;\n]*)/.exec(seg);
    if (!m) continue;
    const args = m[1];
    // Pull out path-like tokens; ignore flags (leading '-').
    const tokens = args.match(/[^\s'"]+/g) || [];
    for (const tok of tokens) {
      if (tok.startsWith('-')) continue;
      const cleaned = tok.replace(/['"]/g, '');
      if (isRealEnvFile(cleaned)) return cleaned;
    }
  }
  return null;
}

// Read all of stdin synchronously.
function readStdin() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0); // nothing to inspect -> allow

  const payload = JSON.parse(raw);
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};

  // Collect the text(s) to scan and the target file path per tool.
  let filePath = '';
  const texts = [];

  switch (toolName) {
    case 'Write':
      filePath = input.file_path || '';
      texts.push(input.content);
      break;
    case 'Edit':
      filePath = input.file_path || '';
      texts.push(input.new_string);
      break;
    case 'MultiEdit':
      filePath = input.file_path || '';
      if (Array.isArray(input.edits)) {
        for (const e of input.edits) texts.push(e && e.new_string);
      }
      if (typeof input.new_string === 'string') texts.push(input.new_string);
      break;
    case 'Bash': {
      // Block staging a real .env file (secrets must stay out of git).
      const env = gitAddsRealEnvFile(input.command);
      if (env) {
        deny(
          `Blocked: the Bash command stages "${env}" into git. ` +
            `A .env file holds secrets and must stay gitignored, never committed. ` +
            `Stage a .env.example with placeholders instead, or confirm this is intentional.`
        );
      }
      // No single target file; scan the command line itself for inline secrets.
      texts.push(input.command);
      break;
    }
    default:
      process.exit(0); // any other tool -> allow
  }

  // File-write tools: real env files legitimately hold secrets, so allow them.
  if (toolName !== 'Bash' && isRealEnvFile(filePath)) process.exit(0);

  const where = filePath
    ? `file "${filePath.replace(/\\/g, '/').split('/').pop()}"`
    : 'the Bash command';

  for (const t of texts) {
    const hit = scanForSecret(t);
    if (hit) {
      const article = /^[aeiou]/i.test(hit) ? 'an' : 'a';
      deny(
        `Blocked: ${article} ${hit} appears to be written into ${where}. ` +
          `Secrets must live in a gitignored .env (not committed). ` +
          `Use a placeholder (e.g. <YOUR_KEY>) in tracked files, or confirm this is intentional.`
      );
    }
  }

  process.exit(0); // clean -> allow
}

// --- Commit-time mode: node secret-guard.cjs --scan-staged ----------------
//
// Same patterns, different question. The PreToolUse hook above asks "should
// this text be written?". This asks "should this file be COMMITTED?".
//
// Two rules invert at commit time:
//   1. Real env files. Writing to .env is legitimate (that is where secrets
//      belong); committing one never is. So isRealEnvFile flips from an
//      allow-reason to a block-reason.
//   2. Failure posture. The hook fails open so a bug cannot wedge the editor.
//      This fails CLOSED, because a scanner that silently passes on error is
//      worse than a blocked commit that `git commit --no-verify` can clear.
//
// It also covers what the hook cannot: commits made by Codex, by another agent,
// or by hand in a terminal outside Claude Code never pass through PreToolUse.

const MAX_SCAN_BYTES = 1024 * 1024; // skip anything bigger; lockfiles/bundles

function stagedPaths() {
  const out = require('child_process').execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return out.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter(Boolean);
}

// Collect the ADDED lines per file from a single `git diff`.
//
// The first version ran `git show :<path>` once per staged file. That is a
// process spawn per file and measured 5.9s on a 200-file commit (~30ms each) —
// far too slow for a hook that fires on every commit. This is two processes
// total no matter how many files are staged.
//
// Scanning additions rather than whole files is also the more correct question.
// A secret already present in HEAD was leaked by an earlier commit; blocking
// this one does not unleak it. What matters is what THIS commit introduces.
function stagedAdditions() {
  const raw = require('child_process').execFileSync(
    'git',
    ['diff', '--cached', '--unified=0', '--no-color', '--diff-filter=ACM'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const byFile = new Map();
  let cur = null;
  let inHunk = false; // '+++ ' is only a header outside a hunk: an added line
                      // whose content starts with '++ ' also renders as '+++ '.
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).replace(/\r$/, '');
        cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
        if (cur && !byFile.has(cur)) byFile.set(cur, []);
      }
      continue; // ---, index, mode, "Binary files ... differ" -> nothing to scan
    }
    if (cur && line.startsWith('+')) byFile.set(cur, byFile.get(cur).concat(line.slice(1)));
  }
  return byFile;
}

function scanStaged() {
  const findings = [];
  const paths = stagedPaths();

  // Filename rule first: committing a real .env is a block regardless of content.
  for (const p of paths) {
    if (isRealEnvFile(p)) findings.push({ file: p, what: 'a real .env file being committed' });
  }

  const additions = stagedAdditions();
  for (const [file, lines] of additions) {
    if (isRealEnvFile(file)) continue; // already reported above
    const text = lines.join('\n');
    if (text.length > MAX_SCAN_BYTES) continue; // generated/minified bulk
    if (text.includes('\0')) continue; // binary
    const hit = scanForSecret(text);
    if (hit) findings.push({ file, what: hit });
  }

  if (!findings.length) {
    console.log('  ✓ no secrets in staged files');
    return 0;
  }

  console.log('');
  console.log('  ✗ secret-guard: COMMIT BLOCKED');
  for (const f of findings) console.log(`      ${f.file}  ->  ${f.what}`);
  console.log('');
  console.log('    Secrets belong in a gitignored .env. Use a placeholder in tracked files.');
  console.log('    If this is a false positive: git commit --no-verify');
  console.log('');
  return 1;
}

if (require.main === module) {
  if (process.argv.includes('--scan-staged')) {
    try {
      process.exit(scanStaged());
    } catch (err) {
      // FAIL CLOSED at commit time (see note above).
      console.error(`  ✗ secret-guard: scan failed, blocking to be safe: ${err && err.message}`);
      console.error('    Bypass once with: git commit --no-verify');
      process.exit(1);
    }
  }
  try {
    main();
  } catch (err) {
    // FAIL OPEN: never block edits because the guard itself broke.
    try {
      process.stderr.write(
        `secret-guard: failing open due to internal error: ${err && err.message}\n`
      );
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  }
} else {
  // Let other harness tooling reuse these patterns instead of copying them.
  module.exports = { scanForSecret, isRealEnvFile, looksHighEntropy };
}
