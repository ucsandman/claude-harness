// Secrets/PII sweep over every file git knows about in the mirror (tracked + untracked, not ignored).
// Usage: node sweep.cjs <repoDir>
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const repo = process.argv[2];
const files = execSync('git ls-files --cached --others --exclude-standard', { cwd: repo, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const patterns = [
  ['openai/anthropic key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['slack token', /\bxox[bpaors]-[A-Za-z0-9-]{10,}/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{20,}/],
  ['resend/stripe/vercel-ish key', /\b(?:re|sk_live|sk_test|pk_live|rk_live|whsec|vcp)_[A-Za-z0-9]{16,}/],
  ['url with credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@[^\s"']+/i],
  ['key=value secret', /\b(?:api[_-]?key|secret|token|password|passwd|auth)\w*\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{20,}/i],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['phone', /(?:^|[^\d])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?:[^\d]|$)/],
  ['long hex/base64 blob', /\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+\/]{60,}={0,2}\b/],
];
const allow = [
  /noreply@anthropic\.com/, /example\.com/, /shields\.io/, /img\.shields/, /\.png|\.jpg|\.gif|\.ico|\.woff/,
];
let scanned = 0, hits = 0;
const perPattern = {};
for (const f of files) {
  const full = path.join(repo, f);
  let buf;
  try { buf = fs.readFileSync(full); } catch { continue; }
  if (buf.includes(0)) continue; // binary
  scanned++;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of patterns) {
      const m = line.match(re);
      if (!m) continue;
      // Hook identity regression checksum, not a credential. Other patterns still scan this line.
      if (name === 'long hex/base64 blob' && f.replace(/\\/g, '/') === 'tools/harness-sync/sync.cjs' &&
          /^\s*return known === 'sha256:[a-f0-9]{64}';\s*$/.test(line)) continue;
      if (allow.some(a => a.test(m[0]) || a.test(line))) continue;
      hits++;
      perPattern[name] = (perPattern[name] || 0) + 1;
      console.log(`${name.padEnd(28)} ${f}:${i + 1}  ${line.trim().slice(0, 140)}`);
    }
  });
}
console.log(`\nscanned=${scanned} files, hits=${hits}`, JSON.stringify(perPattern));
