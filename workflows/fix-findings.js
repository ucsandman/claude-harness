export const meta = {
  name: 'fix-findings',
  description: 'Apply confirmed review findings in disjoint file-ownership groups, review each fix, then run the verify command once',
  whenToUse: 'Workflow({name:"fix-findings", args:{context, findings:[{file, title, detail, fixHint?, severity?}], verify}}) — context = repo path + conventions; verify = the exact shell command that must pass at the end (tests/lint/build).',
  phases: [
    { title: 'Fix', detail: 'one implementer per file-ownership group' },
    { title: 'Review', detail: 'read-only check of each group diff' },
    { title: 'Verify', detail: 'run the verify command once' },
  ],
}

const a = args || {}
if (!a.context || !Array.isArray(a.findings) || !a.findings.length || !a.verify) throw new Error('args.context, args.findings [{file,title,detail}], args.verify are required')

// Group by file so implementers never touch the same file concurrently.
const groups = {}
for (const f of a.findings) {
  const key = String(f.file || '').split(':')[0] || 'unknown'
  ;(groups[key] = groups[key] || []).push(f)
}
const GROUPS = Object.entries(groups).map(([file, items]) => ({ file, items }))
log(GROUPS.length + ' ownership groups for ' + a.findings.length + ' findings')

// Every agent in this workflow shares one working tree with every other agent in it. Incident 2026-09-03 (declick):
// a reviewer ran `git stash` to prove a test failed without the fix, the pop conflicted on a sibling's edit, and a
// 25-file fix pass sat reverted under six concurrent agents. Baselines come from copies, never from mutating the tree.
const SHARED_TREE = '\n\nSHARED WORKING TREE: other agents are editing this repo right now. Do not run ANY git command that changes files or the index: no stash, checkout, restore, switch, reset, clean, add, commit. ' +
  'To prove a test fails without a fix, or to diff against the baseline, take a COPY: `git show HEAD:<path> > <scratchpad>/<name>` (or copy the whole tree into the scratchpad) and run against the copy. ' +
  'Reading git is fine (status, diff, log, show). Any other agent\'s uncommitted change you see in the tree is intentional; do not revert it and do not report it as drift.'

const REVIEW = {
  type: 'object', required: ['ok', 'problems'],
  properties: { ok: { type: 'boolean' }, problems: { type: 'string', description: 'what is still wrong or newly broken, with file:line; empty if ok' } },
}

const results = await pipeline(
  GROUPS,
  (g) => agent(
    a.context + SHARED_TREE + '\n\nYOU OWN ONLY THIS FILE: ' + g.file + ' (edit nothing else; if a fix truly needs another file, stop and report it instead).\nFix these findings, root cause not symptom. Where the failure scenario is testable, add a regression test in the existing test file for this module. Do not run the full suite; run only the tests for this module if a fast way exists.\nFINDINGS:\n' + JSON.stringify(g.items, null, 1) +
    '\nReturn: what you changed (file:line), tests added, and anything you could not fix and why.',
    { label: 'fix:' + g.file.split('/').pop(), phase: 'Fix', model: 'sonnet', agentType: 'sonnet-implementer' }),
  (report, g) => agent(
    a.context + SHARED_TREE + '\n\nREAD ONLY. An implementer just changed ' + g.file + ' to fix these findings:\n' + JSON.stringify(g.items, null, 1) + '\nImplementer report:\n' + report +
    '\nRead the current file and its callers (git diff for that path). Is every finding actually fixed at the root, and is nothing newly broken for sibling callers? Default to ok=false if any finding is only patched at one call site.',
    { label: 'review:' + g.file.split('/').pop(), phase: 'Review', model: 'opus', agentType: 'opus-owner', schema: REVIEW }).then((r) => ({ file: g.file, report, review: r }))
)

const clean = results.filter(Boolean)
const notOk = clean.filter((r) => !r.review || !r.review.ok)
log(clean.length - notOk.length + ' groups clean, ' + notOk.length + ' flagged, ' + (GROUPS.length - clean.length) + ' groups lost')

phase('Verify')
const verify = await agent(
  a.context + SHARED_TREE + '\n\nRun exactly this command and read ALL of its output:\n' + a.verify +
  '\nReport pass/fail with the counts printed (tests run/passed/failed, lint errors). If it fails, quote the failing output verbatim. Do not fix anything.',
  { label: 'verify', phase: 'Verify', model: 'sonnet', agentType: 'sonnet-implementer', effort: 'low' })

return { groups: clean, flagged: notOk, verify }
