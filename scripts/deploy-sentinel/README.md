# Deploy Sentinel

30-minute watchdog over the fleet: polls Vercel deploy states + GitHub CI
(reusing the fleet-briefing collectors), opens an incident exactly once per new
red, emails an alert, auto-resolves when the red clears, and renders
`out/incidents.html` — the red-to-green board.

## Run

```bash
python sentinel.py             # poll + reconcile + board + alert on new reds
python sentinel.py --no-alert  # quiet poll (testing)
```

State: `state.json` (open incidents keyed by run/deployment id + last 20
resolved). Log: `out/run.log`. Config is shared with
`../fleet-briefing/.env` (Resend + Twilio); provider tokens come from
`~/.claude/.secrets.env` via the runner.

## Schedule

Windows Task Scheduler task **DeploySentinel** runs `run-sentinel.sh` every 30
minutes (:12/:42, created 2026-07-10). Manage with
`schtasks /Query|/Run|/Delete /TN DeploySentinel`.

## Diagnosis + draft PRs

The poller only detects/alerts/records. Diagnosis and draft PRs are driven
from interactive sessions (Claude reads the incident, pulls `gh run view
--log-failed`, fixes in a scratchpad clone, opens a DRAFT PR — never
auto-merge). Known constraint: pushing changes to `.github/workflows/*`
requires a GitHub token with the `workflow` scope.
