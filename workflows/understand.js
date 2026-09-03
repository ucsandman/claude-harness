export const meta = {
  name: 'understand',
  description: 'Parallel readers over named subsystems, then one synthesized map answering a question',
  whenToUse: 'Workflow({name:"understand", args:{question, readers:[{label, prompt}], synthesis?, schema?}}) — each reader prompt names the exact files to read and what to extract; question is what the map must answer.',
  phases: [
    { title: 'Read', detail: 'one reader per subsystem, structured output' },
    { title: 'Synthesize', detail: 'dedup + map + constraints' },
  ],
}

const a = args || {}
if (!a.question || !Array.isArray(a.readers) || !a.readers.length) throw new Error('args.question and args.readers [{label, prompt}] are required')

const REPORT = a.schema || {
  type: 'object',
  required: ['findings', 'notes'],
  properties: {
    findings: { type: 'array', items: { type: 'object', required: ['name', 'what', 'where'], properties: {
      name: { type: 'string' },
      what: { type: 'string', description: 'what it does or what is true, 1-3 sentences, concrete' },
      where: { type: 'string', description: 'file:line or file + symbol' },
      relevance: { type: 'string', description: 'why it matters for the question' },
    } } },
    notes: { type: 'string', description: 'state management facts, gotchas, constraints an implementer must know; cite files' },
  },
}

phase('Read')
const reports = (await parallel(a.readers.map((r) => () =>
  agent('QUESTION THIS MAP MUST ANSWER: ' + a.question + '\n\nYOUR SUBSYSTEM: ' + r.prompt + '\n\nRead the actual files (Read/Grep). Report only what you verified in the code; cite file:line. Return structured output only.',
    { label: 'read:' + r.label, phase: 'Read', model: 'sonnet', agentType: 'sonnet-implementer', schema: REPORT })
))).filter(Boolean)
log(reports.length + ' of ' + a.readers.length + ' readers returned')

phase('Synthesize')
const synthesis = await agent(
  'You are synthesizing reader reports into one map. QUESTION: ' + a.question + '\n\nREADER REPORTS (JSON): ' + JSON.stringify(reports) +
  '\n\n' + (a.synthesis || 'Produce: (a) a deduplicated master list grouped by subsystem, each item with where it lives; (b) a direct answer to the question with the evidence; (c) implementation constraints an implementer must respect (state variables, entry points, config, gotchas), each citing a file. Well-organized markdown.'),
  { label: 'synthesize', phase: 'Synthesize', model: 'opus', agentType: 'opus-owner', effort: 'high' }
)
return { synthesis, reports }
