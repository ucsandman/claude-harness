export const meta = {
  name: 'fix-findings',
  description: 'Apply confirmed review findings in disjoint ownership groups, review each fix, re-fix what the reviewer flags once, then run the verify command once',
  whenToUse: 'Workflow({name:"fix-findings", args:{context, findings:[{file, files?, title, detail, fixHint?, severity?}], verify}}) — context = repo path + conventions; files = every file the fix may touch (all call sites of the same behaviour); verify = the exact shell command that must pass at the end (tests/lint/build).',
  phases: [
    { title: 'Fix', detail: 'one implementer per ownership group (every file a finding names)' },
    { title: 'Review', detail: 'read-only check of each group diff, naming any second call site' },
    { title: 'Refix', detail: 'one more round for flagged groups, ownership widened to the files the reviewer named' },
    { title: 'Verify', detail: 'run the verify command once, under a timeout' },
  ],
}

const a = args || {}
if (!a.context || !Array.isArray(a.findings) || !a.findings.length || !a.verify) throw new Error('args.context, args.findings [{file,title,detail}], args.verify are required')

// Ownership is by finding, not by file. 2026-09-03 (declick): file-scoped owners fixed their file, reviewers
// named the twin in another file, and the same defect took four passes. A finding lists every file it may
// touch; findings that share a file merge into one group so no two implementers edit the same file at once.
const filesOf = (f) => [...new Set([String(f.file || '').split(':')[0], ...(Array.isArray(f.files) ? f.files : [])].filter(Boolean))]
const GROUPS = []
for (const f of a.findings) {
  const files = filesOf(f)
  const hit = GROUPS.find((g) => g.files.some((x) => files.includes(x)))
  if (hit) { hit.items.push(f); hit.files = [...new Set([...hit.files, ...files])] }
  else GROUPS.push({ files, items: [f] })
}
log(GROUPS.length + ' ownership groups for ' + a.findings.length + ' findings')

// Every agent in this workflow shares one working tree with every other agent in it. Incident 2026-09-03 (declick):
// a reviewer ran `git stash` to prove a test failed without the fix, the pop conflicted on a sibling's edit, and a
// 25-file fix pass sat reverted under six concurrent agents. Baselines come from copies, never from mutating the tree.
const SHARED_TREE = '\n\nSHARED WORKING TREE: other agents are editing this repo right now. Do not run ANY git command that changes files or the index: no stash, checkout, restore, switch, reset, clean, add, commit. ' +
  'To prove a test fails without a fix, or to diff against the baseline, take a COPY: `git show HEAD:<path> > <scratchpad>/<name>` (or copy the whole tree into the scratchpad) and run against the copy. ' +
  'Reading git is fine (status, diff, log, show). Any other agent\'s uncommitted change you see in the tree is intentional; do not revert it and do not report it as drift.'

// A defect report names one site. The fix is a property of the code base.
const ALL_SITES = '\n\nEVERY CALL SITE: before editing, grep the repo for a second implementation of the same behaviour (a second CLI entry point, a duplicated helper, an engine that copies another engine\'s rule, a check that runs before the step it depends on). ' +
  'List every site you found in your report, fixed or not. If a site is in a file you do not own, say so with file:line and the exact change needed; do not leave it silent.'

const REVIEW = {
  type: 'object', required: ['ok', 'problems', 'files'],
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'string', description: 'what is still wrong or newly broken, with file:line; empty if ok' },
    files: { type: 'array', items: { type: 'string' }, description: 'repo-relative files a follow-up fix must touch, beyond the group\'s own; empty if ok' },
  },
}

const label = (g) => g.files.map((f) => f.split('/').pop()).join('+')
const fixer = (g, brief, phase) => agent(
  a.context + SHARED_TREE + ALL_SITES + '\n\nYOU OWN ONLY THESE FILES: ' + g.files.join(', ') + ' (edit nothing else; if a fix truly needs another file, stop and report it with file:line).\n' + brief +
  '\nWhere the failure scenario is testable, add a regression test in the existing test file for this module. Run only the tests for this module, foreground, with a timeout; never the full suite.' +
  '\nReturn: what you changed (file:line), every call site you found, tests added, and anything you could not fix and why.',
  { label: (phase === 'Refix' ? 'refix:' : 'fix:') + label(g), phase, model: 'sonnet', agentType: 'sonnet-implementer' })
const reviewer = (g, report, phase) => agent(
  a.context + SHARED_TREE + '\n\nREAD ONLY. An implementer just changed ' + g.files.join(', ') + ' to fix these findings:\n' + JSON.stringify(g.items, null, 1) + '\nImplementer report:\n' + report +
  '\nRead the current files and their callers (git diff for those paths, and grep for the same behaviour elsewhere). Is every finding fixed at the root, in every file that carries the behaviour, and is nothing newly broken for sibling callers? ' +
  'Default to ok=false if any finding is only patched at one call site, and put the other sites in `files` with the exact change in `problems`. Do not fail a group for another group\'s uncommitted work or for a red suite you did not cause; name it separately.',
  { label: 'review:' + label(g), phase, model: 'opus', agentType: 'opus-owner', schema: REVIEW })

const results = await pipeline(
  GROUPS,
  (g) => fixer(g, 'Fix these findings, root cause not symptom.\nFINDINGS:\n' + JSON.stringify(g.items, null, 1), 'Fix'),
  (report, g) => reviewer(g, report, 'Review').then((r) => ({ files: g.files, items: g.items, report, review: r }))
)

const clean = results.filter(Boolean)
const flagged = clean.filter((r) => !r.review || !r.review.ok)
log(clean.length - flagged.length + ' groups clean, ' + flagged.length + ' flagged, ' + (GROUPS.length - clean.length) + ' groups lost')

// One more round for what the reviewer flagged, with ownership widened to the files it named. One round, not a
// loop: a second flag goes back to the operator with the reviewer's words, which is cheaper than a fourth pass.
phase('Refix')
const refixed = await parallel(flagged.map((r) => () => {
  const g = { files: [...new Set([...r.files, ...((r.review && r.review.files) || [])])], items: r.items }
  return fixer(g, 'A reviewer found these findings NOT fully fixed. Their exact words:\n' + ((r.review && r.review.problems) || '(no detail)') + '\nOriginal findings:\n' + JSON.stringify(g.items, null, 1) + '\nFix every site they named.', 'Refix')
    .then((report) => reviewer(g, report, 'Refix').then((review) => ({ files: g.files, items: g.items, report, review })))
}))
const stillFlagged = refixed.filter((r) => !r.review || !r.review.ok)
log(refixed.length + ' groups refixed, ' + stillFlagged.length + ' still flagged')

phase('Verify')
const verify = await agent(
  a.context + SHARED_TREE + '\n\nRun exactly this command, foreground, with a hard timeout of 10 minutes (wrap it in `timeout 600 ...` on POSIX; on Windows use the Bash tool timeout parameter and note it), and read ALL of its output:\n' + a.verify +
  '\nReport pass/fail with the counts printed (tests run/passed/failed, lint errors). If it fails, quote the failing output verbatim. If it hangs past the timeout, that IS a failure: report the last test name printed and say it hung. Do not fix anything.',
  { label: 'verify', phase: 'Verify', model: 'sonnet', agentType: 'sonnet-implementer', effort: 'low' })

return { groups: clean, refixed, stillFlagged, verify }
