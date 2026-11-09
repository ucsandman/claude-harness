export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial review: read-only finders per dimension, then a skeptic per finding that defaults to refuted',
  whenToUse: 'Workflow({name:"adversarial-review", args:{scope, dimensions?, votes?}}) — scope is the change-set description (repo, base ref or paths, per-area context). dimensions optional [{key,prompt}]; votes 1 (default) or 3.',
  phases: [
    { title: 'Find', detail: 'read-only finders per dimension' },
    { title: 'Verify', detail: 'adversarial verification of each finding' },
  ],
}

const a = args || {}
if (!a.scope) throw new Error('args.scope is required: repo, change-set (base ref / paths), per-area context')

const SCOPE = a.scope + '\nREAD ONLY: do not modify files or run builds/tests. Cite file:line for every claim.'

const DEFAULT_DIMENSIONS = [
  { key: 'correctness', prompt: 'logic errors, off-by-one, wrong conditionals, state that can go stale or inconsistent, unhandled null/undefined paths, broken invariants across files' },
  { key: 'silent-failures', prompt: 'swallowed errors: empty catch, no response.ok check, fire-and-forget promises, optional schema fields hiding malformed data, handlers reporting success on failure, UI showing stale state when an async step fails' },
  { key: 'integration', prompt: 'call sites the diff broke: renamed or re-typed exports still consumed elsewhere, changed return shapes, config/env keys read under a different name, migrations vs code disagreeing' },
  { key: 'test-gaps', prompt: 'the 3-5 most dangerous untested behaviors only (persistence round-trips, undo of multi-step ops, boundary math, timestamp math at hour boundaries) — not blanket coverage demands' },
]
const WANTED = Array.isArray(a.dimensions) && a.dimensions.length ? a.dimensions : DEFAULT_DIMENSIONS
const DIMENSIONS = WANTED.slice(0, 6)
if (DIMENSIONS.length < WANTED.length) log('dropped ' + (WANTED.length - DIMENSIONS.length) + ' dimension(s) past the cap of 6')
const VOTES = a.votes === 3 ? 3 : 1
// MAX_AGENTS: DIMENSIONS finders (<=6) + DIMENSIONS x PER_DIM findings x VOTES skeptics <= 40
const MAX_AGENTS = 40
const PER_DIM = Math.min(8, Math.max(1, Math.floor((MAX_AGENTS - DIMENSIONS.length) / (DIMENSIONS.length * VOTES))))
log('agents planned: ' + DIMENSIONS.length + ' finders + up to ' + DIMENSIONS.length + ' x ' + PER_DIM + ' findings x ' + VOTES + ' vote(s) = ' + (DIMENSIONS.length + DIMENSIONS.length * PER_DIM * VOTES) + ' (ceiling ' + MAX_AGENTS + ')')

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'file', 'severity', 'detail'],
    properties: {
      title: { type: 'string' },
      file: { type: 'string', description: 'file:line' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
      detail: { type: 'string', description: 'what is wrong, the concrete failure scenario, and the suggested fix' },
    } } } },
}
const VERDICT = {
  type: 'object', required: ['real', 'reason'],
  properties: { real: { type: 'boolean' }, reason: { type: 'string' }, fixHint: { type: 'string' } },
}
const LENSES = ['reachability: is the failure scenario concretely reachable from real inputs?', 'severity: if real, is the stated severity honest, or is it a nit dressed up?', 'fix direction: would the suggested fix actually hold, or does it break a sibling caller?']

function verify(f, d, lens, i) {
  return agent(
    '# EST: 6 calls, 0 files (read-only verification of one finding)\n' + SCOPE + '\nAdversarially verify this finding from a ' + d.key + ' reviewer. Your lens: ' + lens + '\nRead the cited code and trace the actual behavior. Default to real=false unless the failure scenario is concretely reachable. Finding:\n' + JSON.stringify(f, null, 1),
    { label: 'verify' + (VOTES > 1 ? i + 1 : '') + ':' + f.title.slice(0, 30), phase: 'Verify', model: 'sonnet', agentType: 'sonnet-implementer', schema: VERDICT })
}

phase('Find')
const found = await pipeline(
  DIMENSIONS,
  (d) => agent(
    '# EST: 15 calls, 0 files (read-only finder over the change-set)\n' + SCOPE + '\nYour dimension: ' + d.prompt + '\nReport at most ' + PER_DIM + ' findings, most severe first; only report things you are confident are real after reading the actual code (not the diff alone — open the files). No style nits.',
    { label: 'find:' + d.key, phase: 'Find', model: 'opus', agentType: 'opus-owner', schema: FINDINGS }),
  (result, d) => {
    const all = result && result.findings ? result.findings : []
    const kept = all.slice(0, PER_DIM)
    if (kept.length < all.length) log('find:' + d.key + ' returned ' + all.length + ' findings; verifying the first ' + kept.length + ' (ceiling ' + MAX_AGENTS + ')')
    return parallel(kept.map((f) => () =>
    (VOTES === 1
      ? verify(f, d, LENSES[0], 0).then((v) => ({ ...f, dimension: d.key, verdict: v }))
      : parallel(LENSES.map((lens, i) => () => verify(f, d, lens, i))).then((vs) => {
          const ok = vs.filter(Boolean)
          const real = ok.filter((v) => v.real).length >= 2
          return { ...f, dimension: d.key, verdict: { real, reason: ok.map((v) => (v.real ? 'REAL: ' : 'REFUTED: ') + v.reason).join(' | '), fixHint: (ok.find((v) => v.fixHint) || {}).fixHint } }
        }))
    ))
  }
)
const flat = found.filter(Boolean).flat().filter(Boolean)
const confirmed = flat.filter((f) => f.verdict && f.verdict.real)
const unverified = flat.filter((f) => !f.verdict)
log(confirmed.length + ' confirmed, ' + (flat.length - confirmed.length - unverified.length) + ' refuted, ' + unverified.length + ' unverified, across ' + DIMENSIONS.length + ' dimensions')
return {
  confirmed,
  refutedTitles: flat.filter((f) => f.verdict && !f.verdict.real).map((f) => f.title),
  unverified,
}
