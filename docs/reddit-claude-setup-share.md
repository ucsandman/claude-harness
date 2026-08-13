# My Claude Code Setup — Commands, Loops, Skills, Subagents & Hooks

This is the actual custom setup I run on a real production project (an AI-agent governance runtime, Next.js 16 + Postgres, on Windows). I've stripped the secrets and genericized the paths so you can lift any piece of it.

**How to use this:** paste this whole thing into Claude Code and say *"build me equivalents of these, adapted to my project."* Each item has a **Steal this pattern** line describing the reusable idea so it ports to any stack.

Two scopes throughout:
- **Project** = `<project>/.claude/` (lives with the repo, shared with the team)
- **Global** = `~/.claude/` (applies to every project on my machine)

---

## TL;DR — the patterns that actually earn their keep

| Pattern | What it does | Why it's worth copying |
|---|---|---|
| **One "ship" skill** | Lands the branch on main, bumps version, *and re-syncs every doc/count/date to the live code* | Kills "the code shipped but the docs lied" drift |
| **Model-tiered subagents** | Haiku runs the gates, Sonnet audits drift, Opus does security | Pay Opus prices only for the work that needs Opus |
| **Parallel pre-ship sweep** | 3 specialists run at once → one BLOCK/PASS verdict | Go/no-go in one shot instead of a manual checklist |
| **Find-and-fix loop** | Smoke every page → triage → fix top issues in parallel worktrees → integrate | Stop clicking through your app by hand |
| **Self-review → apply loop** | Mines my own agent history for repeated failures, *proposes* CLAUDE.md edits, applies on approval | The setup improves itself instead of me remembering to |
| **Governance hooks** | Pre/Post/Stop tool hooks record + police every tool call | Real guardrails the model can't talk its way past |
| **Cost & loop guards** | Block after N identical calls; track $/session; scan writes for secrets | Caps runaway autonomous runs |
| **Context-keep-warm discipline** | Logs to files, subagents for exploration, `/clear` between tasks | My cost is re-reading context, not output — this is the lever |

---

## 1. Slash commands

Markdown files in `.claude/commands/`. The filename is the command (`/name`); the file is the prompt it runs.

**Project (`<project>/.claude/commands/`):**

- **`/dashclaw-quality`** — Recurring find-and-fix quality pass over the whole app: browser smoke test → run the code gates → triage breakage → fix the top issues in parallel worktrees → verify → ship. (This is the *goal prompt* that boots the dev server and drives the find-and-fix workflow below.)
- **`/dashclaw-retire-legacy`** — Retire a published-but-deprecated SDK the safe way (deprecate now, delete at the next major) without breaking external npm consumers. Drives the deprecation-sweep workflow.
- **`/memory-self-review`** — Mine recent agent history for recurring failures and repeated patterns, audit my memory file's health, and **propose (never apply)** edits to CLAUDE.md / memory for human approval.
- **`/apply-self-review`** — Apply the approved improvements from the latest self-review proposal. Auto-applies the safe, reversible doc/memory edits (with backups); queues anything that rewrites code/config/rules for an explicit go.

**Global (`~/.claude/commands/`):**

- **`/combine`** — Inventory every product in my monorepo, review each one, and design new sellable products by combining existing projects. (A "look across everything I've built and find the leverage" command.)
- **`/handoff-save` `/handoff-load` `/handoff-list` `/handoff-show`** — Save/restore durable context-handoff bundles so a fresh session (or a different machine) can resume mid-task without re-deriving everything.

> **Steal this pattern:** a slash command is just a saved prompt with arguments. The high-value ones aren't "do X once" — they're **named, repeatable workflows you'd otherwise retype**, especially the *meta* ones (`/memory-self-review`, `/combine`) that operate on your own history and repo rather than on a single file.

---

## 2. Skills

Folders in `.claude/skills/<name>/SKILL.md`. Skills are model-invoked (they fire when their `description` matches what you're doing) and can bundle reference docs, scripts, and sub-skills.

**The flagship — a "ship" skill that refuses to leave anything half-done:**

- **`dashclaw-ship`** — The single skill that gets a change *on main and live*. It rebases and lands feature branches, runs the gates, merges + pushes so the deploy fires, bumps the unified platform+SDK version — and then **re-aligns every description of the system with the live code**: README, project docs, SDK READMEs, `/docs`, generated artifacts (API inventory, OpenAPI, the platform skill), plugins/hooks/MCP, marketing/landing copy, and the drift-prone hardcoded counts (routes, SDK methods, MCP tools) and stale date-stamps. The one thing it can't finish itself (a credential-gated publish) it flags loudly instead of silently skipping.

> **Steal this pattern:** most "ship" commands stop at `git push`. The value here is treating **docs + counts + version + generated artifacts as part of "done."** If your repo has any number that's cited in five places (route counts, supported-model lists, pricing), a ship skill that re-derives and re-writes them is the single highest-ROI thing on this list.

**The rest:**

- **`dashclaw-platform-intelligence`** — A platform-expert skill for integration/troubleshooting questions. Prefers *live* queries (a CLI that introspects the running system) over a stale snapshot, so answers don't rot.
- **`route-changes`** — Make focused changes to API routes *with verification baked in* (touches the route, runs the contract checks, won't call it done until they pass).
- **`dashclaw-agent`** — A container skill with 8 sub-skills for a whole domain workflow: `setup`, `build`, `troubleshoot`, `create-policies`, `manage-approvals`, `register`, `compliance-drift-evals`, `instrument`, plus a `knowledge/` folder of reference docs the sub-skills pull from.
- **`gitnexus`** — Wraps a code-intelligence CLI (index a repo, query structure, generate a wiki) so exploration goes through cheap structured queries instead of broad file reads.

> **Steal this pattern:** skills beat commands when (a) you want them to **trigger automatically** by context, or (b) they need to **bundle reference material / scripts / sub-skills**. A "container" skill with sub-skills + a `knowledge/` folder is a clean way to encode an entire multi-step domain workflow.

---

## 3. Subagents (model-tiered by cost)

Markdown files in `.claude/agents/<name>.md` with a `model:` pinned in frontmatter. The point: **route cheap work to cheap models, reserve Opus for the hard stuff.**

**Project (`<project>/.claude/agents/`):**

- **`dashclaw-gate-runner`** — `model: haiku`. Runs lint + the full test suite + the build + contract checks and returns **only the failures + a pass/fail verdict.** Its whole job is keeping multi-hundred-line build logs *out of the main context* — it pipes verbose output to a file and reads back only the failing lines.
- **`dashclaw-drift-auditor`** — `model: sonnet`. Computes the *live* truth for every drift-prone count (route count, SDK method counts, MCP tool counts, the unified version) and greps every place those numbers are cited, reporting mismatches with `file:line`. **Reports only, never edits.**
- **`dashclaw-security-reviewer`** — `model: opus`. Read-only security review specialized to my stack (API-key auth, payment/spend surface, webhooks, tenant scoping, Postgres-via-repositories). Invoked before merging anything that touches auth/secrets/data access. **Reports findings only, never edits.**

**Global (`~/.claude/agents/`):**

- **`security-reviewer`** — `model: inherit`. The generic version of the above for my default stack (auth + billing + secrets + DB). Read-only, reports only.

> **Steal this patterns:** (1) **Tier your models** — a Haiku agent that just runs gates and returns failures is dirt cheap and runs constantly; save Opus for security and architecture. (2) **Read-only "reporter" agents.** Telling an agent *"you REVIEW and REPORT, you never edit"* in the system prompt makes it a trustworthy reviewer you can run on every diff without it going rogue and "helpfully" rewriting things. (3) **Context firewalls** — an agent whose entire value is *"run the noisy thing, return only the 4 lines that matter"* keeps your main thread cheap.

---

## 4. Workflows — the actual "loops"

JavaScript files in `.claude/workflows/` that deterministically orchestrate many subagents (fan-out, parallel stages, verdict synthesis). These are where the real leverage is.

- **`dashclaw-preship-sweep.js`** — **Pre-ship go/no-go.** Runs three specialists *in parallel* and synthesizes one BLOCK/PASS verdict: the Haiku gate-runner, the Sonnet drift-auditor, and the Opus security-reviewer (the model-tiered roster from §3). Replaces the manual "lint+test+build, then check the counts, then eyeball security" sequence with one call.
- **`dashclaw-find-and-fix.js`** — **The quality loop.** Smoke-tests every page + runs the code gates → triages breakage into atomic issues → fixes the top ones in **parallel git worktrees** (so the agents don't collide) → integrates the green diffs sequentially. Phases: Discover → Detect → Triage → Fix → Integrate.
- **`legacy-sdk-deprecation-sweep.js`** — Audits every live reference to a deprecated SDK, then applies a consistent deprecate-or-remove sweep across all surfaces in parallel worktrees. Phases: Audit → Plan → Sweep → Integrate.

> **Steal this pattern:** the recurring shape is **fan-out → verify/triage → integrate.** Two tricks make it work: (1) **parallel git worktrees** so multiple fix-agents edit isolated copies and never step on each other, then you integrate the diffs one at a time; (2) a **synthesis step** at the end that turns N independent reports into one verdict/plan instead of dumping all N on you. Start with the pre-ship sweep — it's the easiest win.

---

## 5. Hooks — guardrails the model can't talk past

Hooks are configured in `settings.json` and fire on harness events (not on the model's goodwill). This is where "automated behavior" actually lives.

**Governance / observability (Pre + Post + Stop tool, project):**
- **`dashclaw_pretool.py`** (`PreToolUse`) — Evaluates every tool call against policy before it runs; exits `0` to allow or `2` to block.
- **`dashclaw_posttool.py`** (`PostToolUse`) — Records the outcome of each governed call (a short output summary + structured metadata).
- **`dashclaw_stop.py`** (`Stop`) — Captures the turn's token usage from the transcript and attaches it to the record. Never blocks.

**Safety (global):**
- **`secret-guard.cjs`** (`PreToolUse` on Write/Edit/Bash) — Blocks any tool call about to write a *real, high-confidence* secret into the repo or commit it. Fail-open by design, allows `.env` files, skips obvious placeholders (`YOUR_`, `EXAMPLE`, `PLACEHOLDER`).
- **`ts-check.sh`** (`PostToolUse` on Edit/Write of `.ts`/`.tsx`) — Runs `tsc --noEmit` after every TypeScript edit so type errors surface immediately, not at the push gate.

**Design discipline (project):**
- **`impeccable-reminder.py`** (`UserPromptSubmit`) — When a prompt contains UI/design/copy keywords, injects a reminder to read the canonical design-context file first. Keeps visual work on-brand without me having to remember.

**Context (project):**
- **`codebase_map_context.py`** (`SessionStart`) — Prints an index of the repo's codebase-map files into context at session start, so the model is grounded without re-deriving structure every time.

**Cost & loop guards (auto-generated by a monitoring tool, project):**
- **Stuck-loop guard** (`PreToolUse`) — Blocks after 5 consecutive *identical* tool calls. Kills infinite retry loops.
- **Repeated-tool-run guard** (`PreToolUse`) — Same idea for repeated tool *sequences*.
- **Cost-budget guards** (`PostToolUse`) — Track $/session against a budget (~3× project median) using a model pricing table; warn, don't block.
- **Secret-output guard** (`PreToolUse`) — Scans Write/Edit calls for Stripe/Anthropic/GitHub/AWS/private-key patterns; exits `2` on a match.

> **Steal this pattern:** if you ever say *"from now on, every time X, do Y"* — that's a **hook**, not a memory note. The model can't reliably promise to always do something; the harness can. The cheap wins: a **secret-guard** on Write/Edit/Bash, a **type-check (or lint) on save**, and a **stuck-loop guard** that blocks after N identical calls so an autonomous run can't burn your budget spinning.

---

## 6. The self-improvement loop

Worth calling out as its own thing because it's the most "meta" piece:

1. **`/memory-self-review`** reads my recent agent history (via a memory MCP) + usage stats, finds recurring failure modes and repeated patterns, audits my MEMORY.md for bloat/staleness, and writes a **proposal** of CLAUDE.md / memory edits. It never edits anything itself.
2. I read the proposal.
3. **`/apply-self-review`** applies the approved, reversible edits (with backups) and queues anything riskier for an explicit go.

> **Steal this pattern:** point Claude at **your own logs** and have it tell you which mistakes you keep making, then turn those into permanent rules — with a **human approval gate** between "propose" and "apply." The gate is the whole trick: auto-applying edits to your rules file is how you get silent drift.

---

## 7. Settings & config tricks

In `settings.json` (global + project):

- **`effortLevel`** — Set per scope (`high` on the project, higher globally). Dial up reasoning where the work is hard.
- **Model-tiering by task** — Reviews/exploration/boilerplate → Sonnet/Haiku; reserve the top model for genuinely hard reasoning. (Input tokens on the cheaper tiers are a small fraction of the cost.)
- **Statusline** — A custom script renders a live status line (branch, context %, cost) so I can *see* when context is getting expensive.
- **`Read` deny on `**/.secrets.env`** — A hard permission deny so no agent can ever read the secrets file, regardless of prompt.
- **Env wiring** — Secrets loaded from one gitignored file via a shell-init hook, never pasted into prompts or settings.

> **Steal this pattern:** the biggest lever isn't any one command — it's **context/cache discipline.** My cost is overwhelmingly *re-reading context every turn*, not generating output. So: log build/test output to files and read only the failures, use subagents for exploration (their context is discarded), and `/clear` between unrelated tasks instead of dragging a 300K-token thread into the next job. A subagent that returns "only the 4 failing lines" pays for itself every run.

---

## 8. Plugins & marketplaces I pull from

I run a mix of marketplace plugins on top of the custom stuff above. The ones I actually use day-to-day:

- **superpowers** — skill framework (TDD, debugging, brainstorming, plan-writing, parallel-agent dispatch, worktrees).
- **compound-engineering** — a big library of review/plan/commit/debug commands and reviewer personas.
- **claude-mem** — persistent cross-session memory (the thing `/memory-self-review` mines).
- **impeccable** — design/frontend skill + the design-reminder hook.
- **pr-review-toolkit** / **code-review** — specialized review agents.
- **claude-code-setup** — recommends hooks/agents/skills/MCP for a given codebase (good starting point if you're new to this).
- **context7** — live library docs MCP (so the model isn't guessing API signatures from stale training data).
- **codex**, **supergoal**, **last30days**, plus domain ones (github, stripe, obsidian, marketing).

> **Steal this pattern:** start with **`claude-code-setup`** (it'll analyze your repo and recommend automations), add **`superpowers`** for the skill framework, and **`context7`** so the model stops hallucinating API calls. Then build the project-specific commands/agents/hooks/workflows above on top.

---

## Where to start if you're copying this

1. **One subagent that runs your gates and returns only failures** (Haiku). Instant context savings.
2. **A secret-guard hook** on Write/Edit/Bash. Five minutes, saves you from a very bad day.
3. **A "ship" command** that re-syncs your docs/counts/version to the code, not just `git push`.
4. **A pre-ship sweep workflow** — gates + drift + security in parallel → one verdict.
5. **`/memory-self-review`** pointed at your own history, with a human approval gate before anything edits your rules.

Everything here is just **markdown prompts + a little Python/JS + frontmatter.** None of it is magic — it's the same five primitives (commands, skills, subagents, hooks, workflows) pointed at the boring, repeated, drift-prone parts of *my* project. Point them at yours.
