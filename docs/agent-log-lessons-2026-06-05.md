# Lessons from My Agent Logs (reviewed 2026-06-05)

Moved out of `~/.claude/CLAUDE.md` on 2026-06-07 to keep that always-loaded file lean. These are retrospective reinforcements of rules that already live in CLAUDE.md — kept here for reference, not as always-on context.

Patterns from 658 sessions of my own agent history — reinforcements of the rules, at the points they were most often violated:

- **Don't trust agent self-reports — re-read the real code.** When a sub-agent, plan, or implementer claims something works/passes/is fixed, verify against the actual files and test output before repeating the claim. My #1 recurring frustration was "it confirmed the story I wanted to hear." For `/security-review`-style tasks, trust only what you actually read.
- **Verify model IDs against current reality; never hardcode stale ones.** Before touching model/provider config, confirm the latest IDs (Context7 / web) and keep one source of truth. Latest Opus is **`claude-opus-5`** (verified 2026-08-11). Recurring bug class: "Sonnet 4 vs 4.5", "Opus 4.6 is out", "Unknown model: gpt-5.3-codex".
- **Read-only means read-only.** For review/explore/research tasks, don't edit/commit/push/refactor unless asked.
- **Don't skip the publish tail.** When changing paths, SDK versions, or hooks, also update downloadables, bump versions, and republish.
- **UI work: use the design skills** (impeccable / frontend-design) — don't ship default-looking UI.

---

## 2026-08-10 — The Hooop "no bot API" miss (two agents, same blind spot)

**What happened.** Wes gave OpenClaw a `/team` command. OpenClaw and Claude Code worked the task together. A prior report stated Hooop had **"no bot API,"** so both agents designed a browser-automation adapter: Playwright, DOM selectors, a live browser to babysit, and a human clicking "admit" in the UI.

The premise was false. The repo (`~/hooop/plugins/hooop/dashboard/app/api/` in WSL) holds **41 REST route files**, including the exact peer-join flow the agents were re-implementing through the DOM:

- `POST /api/share` — mint a share link (host)
- `POST /api/share/redeem` `{token, name}` — named join request
- `POST /api/share/join/[ticket]/admit` — admit a peer, scriptable, no clicking
- `POST /api/share/claim` — durable peer cookie
- `POST /api/sessions/[id]/message` `{text}` — post a turn, attributed to the peer's name

One `ls` of the `api/` directory would have shown this. Instead, both agents inherited a summary sentence and built on top of it.

**The failure mode: a prior agent's summary was treated as a property of the system.** "No bot API" was a *claim*, not an observation. Nobody enumerated the routes. Both agents then reasoned correctly from a wrong axiom, which is why neither caught it — the design was internally consistent and completely unnecessary.

**Two agents does not equal two checks.** A shared upstream summary is a single point of failure. When agents collaborate, they inherit each other's premises and each one's agreement raises false confidence in the other's. Multi-agent agreement is not verification; it amplifies an unverified premise instead of testing it.

**Rules this produced:**

1. **Enumerate, don't ask.** Before building any adapter, wrapper, bot, or automation: `ls` the routes directory, read the CLI's `--help`, list the exported functions. Directory listings are cheap; wrong architectures are not.
2. **A capability claim from any agent (including a past me) is a hypothesis with an owner and a timestamp.** Re-derive it from source before it becomes load-bearing. See the "Verify, Don't Trust" section in CLAUDE.md.
3. **"There is no X" needs stronger evidence than "there is an X."** A negative capability claim rules out entire designs, so verify it directly against the source before you accept it.
4. **Browser automation is the last resort, never the first.** Reaching for Playwright/DOM selectors against a system that ships an HTTP API is a signal you skipped step 1. This complements the browser-QA playbook in CLAUDE.md: scripted Playwright is right for *testing a UI*, wrong for *driving a backend that has an API*.
5. **The cost is asymmetric.** Checking costs one tool call. Not checking cost a Playwright harness, DOM selectors, and a human in the loop for a job that was five `curl` calls.
