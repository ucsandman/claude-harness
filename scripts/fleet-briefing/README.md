# Fleet Briefing

7am morning status: one script collects overnight Vercel deploys, GitHub CI,
Stripe revenue, and Sentry issues, renders `out/briefing.html` (the board),
emails the board via Resend, and texts a 3-line SMS via Twilio.

## Run

```bash
python briefing.py                  # collect + render board only
python briefing.py --sms --email    # what the scheduler runs
```

Provider tokens come from `~/.claude/.secrets.env` (the runner sources it with
`set -a`; interactive Bash-tool runs inherit it automatically). Briefing config
lives in `.env` (see `.env.example`): Twilio SID/from/to, SMS policy
(`daily` | `anomaly`), email to/from.

Outputs: `out/briefing.json`, `out/briefing.html` (self-contained, light/dark),
`out/run.log` (scheduler runs). Exits non-zero only if every collector fails;
individual collector or delivery failures log and render as warnings.

## Schedule

Windows Task Scheduler task **FleetBriefing7am** runs `run-daily.sh` daily at
6:57am (created 2026-07-10). Manage it with
`schtasks /Query|/Run|/Delete /TN FleetBriefing7am`. The runner unsets
ANTHROPIC_API_KEY defensively; delivery is python-only (no headless claude —
the Artifact tool isn't available in `-p` mode, which is why the board is
emailed rather than republished to a claude.ai artifact).

## Pending config (script degrades gracefully without these)

- `TWILIO_ACCOUNT_SID`, `TWILIO_FROM_NUMBER`, `BRIEFING_SMS_TO` in `.env` → activates SMS
- `SENTRY_AUTH_TOKEN` with org:read/project:read/event:read in `~/.claude/.secrets.env` → activates Sentry tile
