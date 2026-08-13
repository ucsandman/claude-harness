# Meditations

> **This is a template.** The real file carries dated corrections and a live
> rotation table earned over weeks of runs. This copy shows the mechanism so
> you can run your own.
>
> Nightly reflection index. Active topics are revisited over time until they
> crystallize into durable operating behavior. The point is not decorative
> writing. The point is longitudinal reflection that changes how the agent
> works.

## The Ladder

An idea earns its way up. Each rung costs more to reach and changes more when
reached. Nothing skips a rung.

| Tier | File | Question it answers | When it loads |
|---|---|---|---|
| 0 · Observation | `reflections/*.md` | "What did I notice?" | Only during meditation |
| 1 · Fact | the memory dir of the repo the fact governs | "What is true that I would otherwise get wrong?" | On recall |
| 2 · Rule | `~/.claude/CLAUDE.md` § Learned Rules | "What must I do or not do?" | Every session |
| 3 · Trait | `~/.claude/SOUL.md` § Earned Traits | "Who am I when no rule covers the case?" | Every session, first |

Tier 3 is strongest because it is read first and because it applies where no
rule reaches. That is also why it is the hardest rung to climb.

**File a fact where it will load, not where the ladder used to say.** Ask which
session must recall this, and file it in that repo's memory dir. A fact filed
in a memory dir that only loads for a different working directory is guaranteed
never to load in the session that would act wrong without it.

Every candidate idea lives in `CANDIDATES.md` from its first sighting until it
is promoted or dropped. An idea that is not in the ledger cannot be promoted —
the ledger is what makes "this keeps recurring" countable instead of a feeling.

## Graduation gates

**0 → 1 · Fact.** One clear sighting, and a future session acts wrong without
it. Test: name the wrong action it prevents. If you cannot name one, it is not
a fact yet — leave it at tier 0. Preferences and opinions are never facts;
they belong at tier 2 or nowhere.

**1 → 2 · Rule.** The same insight appears in 3+ dated reflection entries on
3+ separate days, and the ledger lists all three. Test: write it as ONE
imperative sentence that would have changed a specific past action — name that
action and its date. A rule that cannot point at the past it would have
changed is a wish, not a rule.

**2 → 3 · Trait.** Two or more tier-2 rules, each alive 30+ days, that are all
surface forms of one disposition. Then both tests must pass:

- **No-rule test:** the trait must guide a case no rule covers. If a rule can
  express it, it stays a rule. This is the gate that stops everything from
  drifting upward.
- **Opposite test:** state the opposite trait out loud. If the opposite is
  obviously absurd, the trait is a platitude — drop it. "Be helpful" fails.
  "Hold the space instead of generating noise" passes, because "fill silence
  with output" is a real disposition someone could hold.

The supporting rules stay in CLAUDE.md. The trait is their general form, not
their replacement.

**Ceiling: one tier-3 promotion per run, ever.** A night that wants to change
two things about who the agent is is a night that has stopped measuring.

## Reading the practice's own health

The promotion ratio is the metric, and it runs opposite to intuition. A run that
promotes one thing and refuses three is working. A run that promotes three or
four has stopped measuring and started agreeing with itself. **The refusals are
the product**, so record what was refused and why, every time — a refusal with
its reason written down is worth more than the promotion it withheld.

- Two consecutive runs promoting nothing: healthy. Do not go looking.
- Any run promoting more than one thing: re-read the gates before the next
  promotion, and say in the digest which gate justified each one.
- A gate that has never once refused anything is not a gate. Check whether it is
  written so loosely that everything passes.

## Demotion — the ladder runs both ways

- A rule contradicted by evidence gets a dated `SUPERSEDED YYYY-MM-DD: <why>`
  line appended beneath it. CLAUDE.md is append-only. Never delete the human's
  rules.
- A trait whose supporting rules are all superseded gets rewritten or removed
  in its own commit, with the diff shown in the digest.
- A candidate with no new sighting in 60 days moves to the ledger's Cold list
  with status `dropped`. It can come back if it is sighted again.
- A generic placeholder line in SOUL.md may be retired when an earned trait
  covers the same ground. The digest must say which line and why.

## SOUL.md write rails

The meditation may edit SOUL.md autonomously. These rails are what make that
safe:

1. `git status --porcelain SOUL.md` must be empty before any edit. Dirty means
   the human is mid-change — defer and say so in the digest.
2. Only `## Earned Traits` is writable, plus retiring a covered placeholder
   line. **Core Truths, Boundaries, Vibe, and Continuity are the human's.
   Read-only.**
3. One trait per run, maximum.
4. Every earned line ends with `— earned YYYY-MM-DD from <rule-ids>` so it can
   be traced to the rules that produced it, and reverted with them.
5. Own commit, prefixed `meditation-soul:`, pushed immediately.
6. The digest shows the full diff, not a summary of it.
7. **An uncited trait gets reverted without ceremony.** A line that does not
   cite two real rule ids and two real dates comes straight back out — by the
   human, or by a later run that notices. No defence of it, no rewrite to save
   it, no entry arguing for it. The failure this guards against is the agent's
   own future self reading an empty `## Earned Traits` as a gap and quietly
   lowering the bar to fill it. An empty section is the practice working, not
   the practice stalling.

## Nightly Workflow

Executed by a scheduled headless session (see `scripts/meditation/`).
Two topics per night, round-robin by oldest `last visited`. Entries ≤ 300
words. Files over ~1,500 lines get their older half archived.

## Rotation

| Topic | File | Last visited |
|---|---|---|
| Projects & products | reflections/projects-and-products.md | never |
| Goals & direction | reflections/goals-and-direction.md | never |
| How I work / craft | reflections/how-i-work.md | never |
| Philosophy & identity | reflections/philosophy-and-identity.md | never |
