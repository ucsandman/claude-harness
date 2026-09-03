export const meta = {
  name: 'tournament',
  description: 'Idea tournament: N angled candidates, a judge panel, then one synthesized spec from the winner plus grafts',
  whenToUse: 'Workflow({name:"tournament", args:{brief, lenses:[{key,angle}], outputRules?, judgeLenses?:[string], criteria?, synthesisTask?, schema?}}) — brief is the product/problem context incl. files to read; lenses are the assigned angles (one candidate each).',
  phases: [
    { title: 'Candidates', detail: 'one independent concept per lens' },
    { title: 'Judging', detail: 'judge panel scores every candidate' },
    { title: 'Synthesis', detail: 'winner + grafts into one implementable spec' },
  ],
}

const a = args || {}
if (!a.brief || !Array.isArray(a.lenses) || !a.lenses.length) throw new Error('args.brief and args.lenses [{key, angle}] are required')

const BRIEF = a.brief
const OUTPUT_RULES = a.outputRules || 'Return a complete, opinionated, implementable concept. Be specific and concrete. Do not hedge with options; commit to one vision.'
const CRITERIA = a.criteria || 'Score EVERY candidate 1-10 on each of five criteria and report the total (max 50): (1) fit to the brief, (2) impact if shipped, (3) distinctiveness, (4) implementability under the stated constraints, (5) risk (10 = lowest risk).'
const JUDGE_LENSES = Array.isArray(a.judgeLenses) && a.judgeLenses.length ? a.judgeLenses : [
  'JUDGE AS THE USER described in the brief: reward what they would actually want and use; punish anything that ignores their stated complaint or constraint.',
  'JUDGE AS A PRACTICING DOMAIN EXPERT: taste, coherence, whether it is distinctive versus generic, whether it holds up under real use.',
  'JUDGE AS THE IMPLEMENTING ENGINEER: can this be built well under the stated constraints? Punish concepts that only work as a mockup.',
]
const SYNTHESIS_TASK = a.synthesisTask || 'Produce the final, complete IMPLEMENTATION SPEC: resolve all judge feedback, mitigate the stated risks, re-read the actual source files in the brief so every instruction maps onto real code, and give a build order with what to verify after each step. One long markdown document; the implementer should never have to invent a value.'

const CANDIDATE = a.schema || {
  type: 'object',
  required: ['name', 'thesis', 'plan', 'signatureMoves', 'risks'],
  properties: {
    name: { type: 'string', description: 'short memorable name' },
    thesis: { type: 'string', description: '2-3 sentences: the core idea and why it fits' },
    plan: { type: 'string', description: 'the full concept, concrete and specific: what changes, where, exact values where they matter' },
    signatureMoves: { type: 'string', description: '3-5 distinctive touches that make this not generic' },
    risks: { type: 'string', description: 'honest weaknesses' },
  },
}
const JUDGE = {
  type: 'object',
  required: ['scores', 'winner', 'grafts', 'reasoning'],
  properties: {
    scores: { type: 'array', items: { type: 'object', required: ['candidate', 'total'], properties: {
      candidate: { type: 'number', description: '1-based candidate index' },
      total: { type: 'number', description: 'sum of the criterion scores' } } } },
    winner: { type: 'number', description: '1-based index of your top pick' },
    grafts: { type: 'string', description: 'the 3-6 best specific ideas from NON-winning candidates worth grafting into the winner' },
    reasoning: { type: 'string', description: 'why the winner wins, plus a one-line verdict per candidate' },
  },
}

phase('Candidates')
const candidates = (await parallel(a.lenses.map((l, i) => () =>
  agent(BRIEF + '\n\nYOUR ASSIGNED DIRECTION #' + (i + 1) + ' — ' + l.angle + '\n\n' + OUTPUT_RULES,
    { label: 'candidate:' + l.key, phase: 'Candidates', model: 'opus', agentType: 'opus-owner', schema: CANDIDATE })
))).filter(Boolean)
log(candidates.length + ' of ' + a.lenses.length + ' candidates returned')
if (!candidates.length) return { error: 'no candidates returned' }

const dossier = candidates.map((c, i) => '=== CANDIDATE ' + (i + 1) + ' ===\n' +
  Object.entries(c).map(([k, v]) => k.toUpperCase() + ': ' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n')).join('\n\n')

phase('Judging')
const verdicts = (await parallel(JUDGE_LENSES.map((lens, i) => () =>
  agent('You are judging a tournament of candidate concepts.\n\n' + BRIEF + '\n\n' + lens + '\n\n' + CRITERIA + '\n\nTHE CANDIDATES:\n\n' + dossier,
    { label: 'judge:' + (i + 1), phase: 'Judging', model: 'opus', agentType: 'opus-owner', schema: JUDGE })
))).filter(Boolean)
log(verdicts.length + ' of ' + JUDGE_LENSES.length + ' judges returned')

const totals = candidates.map((c, i) => ({
  idx: i + 1,
  name: c.name || a.lenses[i].key,
  total: verdicts.reduce((s, j) => s + ((j.scores.find((x) => x.candidate === i + 1) || {}).total || 0), 0),
  firstPlaceVotes: verdicts.filter((j) => j.winner === i + 1).length,
}))
totals.sort((x, y) => y.firstPlaceVotes - x.firstPlaceVotes || y.total - x.total)
log('Ranking: ' + totals.map((t) => t.name + ' (' + t.firstPlaceVotes + ' votes, ' + t.total + ' pts)').join(' | '))

const champion = candidates[totals[0].idx - 1]
const runnerUp = totals[1] ? candidates[totals[1].idx - 1] : null
const feedback = verdicts.map((j, i) => 'Judge ' + (i + 1) + ' grafts: ' + j.grafts + '\nJudge ' + (i + 1) + ' reasoning: ' + j.reasoning).join('\n\n')

phase('Synthesis')
const spec = await agent(
  BRIEF + '\n\nA tournament ran. THE WINNING CANDIDATE (implement this):\n' + JSON.stringify(champion, null, 1) +
  (runnerUp ? '\n\nRUNNER-UP (graft its best ideas where they strengthen the winner without diluting it):\n' + JSON.stringify(runnerUp, null, 1) : '') +
  '\n\nJUDGE FEEDBACK AND REQUESTED GRAFTS:\n' + feedback + '\n\nYOUR JOB: ' + SYNTHESIS_TASK,
  { label: 'synthesis', phase: 'Synthesis', model: 'fable', effort: 'high' }
)

return { ranking: totals, championName: totals[0].name, spec, candidates }
