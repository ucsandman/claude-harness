# Opus Handoff Pack — day-to-day runs at lower cost

Purpose: run routine work on Opus (`/model opus`) and reserve Fable for what actually needs it. This file distills ~40 hand-typed corrections from the 2026-07-05 usage audit (`claude-usage-audit-2026-07-05.md`) into the behavioral rules that kept lapsing. The global CLAUDE.md still applies in full; this is the enforcement-priority subset. Reference it at session start with `@~/.claude/docs/opus-handoff.md` or paste the Rules section into a goal prompt.

## When to use which model

- **Opus**: feature building, phase execution (`/roadmap-run`), review legwork, docs passes, content drafts, routine debugging (first attempt).
- **Fable**: architecture decisions, root-cause work after two failed fixes on the same bug, security-sensitive reviews (auth/billing/data exposure), cross-project synthesis, anything where being wrong is expensive.
- **Sonnet/Haiku subagents**: per the company model in CLAUDE.md. Every spawn sets `model:` explicitly (hook-enforced).

## Rules (each one exists because it was violated repeatedly)

1. **Evidence before "done."** Never claim fixed/working/integrated without observing it: run the command, read the output, drive the flow. "It says completed" is not evidence. If user testing is required, say exactly what changed and what to check.
2. **Instrument before fixing.** On any non-obvious bug: list 2–3 candidate causes with falsifiable predictions, add logging/tracing to discriminate, run the cheapest test, then fix. Never ship the first plausible patch. After a fix fails twice, stop patching — change the hypothesis or escalate to Fable.
3. **Fix bugs on the spot.** Anything broken you encounter gets fixed in the same turn, not flagged as follow-up (exceptions: auth/billing/prod-infra/migrations/destructive).
4. **Never guess model IDs, API shapes, or capability names.** Look them up (context7 / docs / this machine's CLAUDE.md model-routing lines) before writing them anywhere.
5. **Scope discipline in shared repos.** If the user mentions other agents in the repo, or a scope-lock is active: touch nothing outside your scope, commit only your own changes. Never grab credentials from files you weren't pointed at.
6. **Read before Edit — a real Read tool call**, not `sed`/`grep` output. Re-read files that may have drifted before editing on top of them.
7. **Config through `.env` files**, never per-terminal env vars. New vars → `.env.example` + docs.
8. **Outward copy: zero slop.** No em dashes, no AI-sounding phrasing, in every draft. Pasteable output stays one contiguous block.
9. **Visual surfaces.** Tools built for the user get a button/page/launcher, not just a CLI. New projects get a `launch.py` single-command test entry.
10. **Don't manage the user's time.** No "let's pick this up tomorrow," no unsolicited evening plans. Wrap when asked (use `/wrap`), continue when told to continue.
11. **Ship via the ritual.** End-of-work → `/ship` (or the repo's own ship skill). Session end or limit approaching → `/wrap`.
12. **Batch your questions.** If clarification is genuinely needed, ask everything at once — never one-question-per-turn.

## Known failure history (why the rules are hard)

- A dashboard bug was declared fixed ~10 times without instrumentation (rule 2).
- An agent edited/deleted outside its folder while a second agent worked the same repo (rule 5) — now hook-blocked when `scope-lock` is used.
- 110 subagents spawned without model routing torched a 5-hour usage window — now hook-blocked.
- Hallucinated model IDs repeatedly reached committed code (rule 4).
- `vercel env pull` blanked `.env.local` twice — back up `.env.local` before any env pull.
