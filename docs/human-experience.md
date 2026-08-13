# The Human Experience Contract (global)

Adopted 2026-07-07, generalized from DashClaw's `HUMAN-EXPERIENCE.md`. Governs the
human experience of everything Claude builds for Wes, in every project. The
always-loaded summary lives in `~/.claude/CLAUDE.md` → Core Philosophy §5; this
file is the full text.

**The founding incident (DashClaw v4.33.0):** a feature worked, the data was
right, the automation was elegant — and the human's role required opening a
GitHub Actions run, copying a shell command out of a table, and pasting it into
a terminal. The operator's verdict: *"I do not want to go into GitHub and copy a
command and run it in a terminal."* That ship was incomplete. This contract
exists so it never happens again — anywhere.

## The axiom

Everything built has two kinds of consumers:

- **Agents and automation** consume APIs, MCP tools, CLIs, hooks. Text and JSON
  are their native habitat.
- **Humans** consume pages. They judge in seconds, by sight. Their native
  habitat is a rendered surface with visual hierarchy: a status chip, a count
  that's red, a button that says what it does.

Every capability serves both, and **the human surface is never the optional
one**. When only one interface gets built first, it is the human one. This is
the standing correction for the AI's systematic bias: it builds for what it
knows — code, terminals, JSON, GitHub — and forgets the operator is a visual
human.

## The contract — every ship answers all six

1. **Understandable at first glance.** Every shipped capability is explained
   where a human will actually see it: a page, a dashboard, a panel. The
   first-glance test: a capable stranger looking at the surface for ten seconds
   can say what it does and why it matters. If understanding it requires
   reading a spec, a README section, or a workflow file, it fails.

2. **Operable by click, not by command.** Wherever the human's role in a loop
   is judgment — review, approve, deny, ratify, tune, dismiss — that judgment
   is exercised through a **button, toggle, or form in the product**. "Copy
   this command," "open GitHub," "edit this file," or "run this script" is
   never the primary human path.

3. **Terminals are for agents; the zero-terminal test.** CLI, API, MCP, and CI
   surfaces are legitimate **secondary** interfaces for agents, automation, and
   developers wiring integrations. The test at ship time: walk the entire human
   role for the feature end to end and count the terminal commands and GitHub
   visits required. **The count must be zero.** (Development acts — committing
   code, publishing packages, rotating credentials — are outside this test;
   they are maintainer acts, not product workflows.)

4. **Public-facing surfaces ship with the feature.** Where a project has
   marketing pages, docs pages, or a landing page that claims completeness,
   they grow with the capability — in the **same ship**, not a later sweep. A
   capability absent from pages that claim completeness is a false claim.

5. **API-only is a decision, never a default.** A capability may legitimately
   have no operational UI (pure SDK plumbing, an internal contract). That is an
   **explicit recorded decision with a reason** — and even then, the
   capability's *existence and purpose* must still be visible to humans
   somewhere (docs, setup page, dashboard). Silent API-only ships are the
   failure mode this contract exists to kill.

6. **Rendered proof, not asserted proof.** Before a feature is called done,
   drive the actual page (headless browser / frontend-verify) and confirm the
   new surface renders with real data and the judgment controls work. Unit
   tests prove data exists; only a rendered page proves a human can see and
   use it.

## Scope

This applies to **everything**, not just products: internal tools, one-off
scripts, analysis outputs, monitoring, automations. If the deliverable is a
script, the deliverable includes the button or local page that runs it. If the
deliverable is data, the deliverable includes the rendered view of it
(Artifact, local HTML, dashboard panel).

## The design bar

Human surfaces follow the project's own design system where one exists (e.g.
DashClaw's `.impeccable.md`). Where none exists, use the `impeccable` /
`frontend-design` / `dataviz` skills — restrained, legible, developer-brand
register (Linear, Vercel, Grafana), not decoration.

## Relationship to other rule carriers

- `~/.claude/CLAUDE.md` Core Philosophy §5 is the always-loaded summary.
- `~/.claude/CLAUDE.md` Definition of Done includes the human-surface gate.
- The existing "Mock before you wire" preference is the design-time twin:
  show the clickable mock before wiring production code.
- Project files (like DashClaw's `HUMAN-EXPERIENCE.md`) may extend this with
  project-specific clauses; they never weaken it.
