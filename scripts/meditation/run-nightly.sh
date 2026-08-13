#!/usr/bin/env bash
# Nightly meditation runner — invoked by Windows Task Scheduler (6:40am).
# Headless Claude session runs the /meditate skill: Opus nightly, Fable on
# Sundays (weekly synthesis), xhigh effort. Bills the subscription.
#
# The session runs with bypassPermissions (see the WHY block below), so its
# blast radius is bounded by removing capability instead of by asking:
#   - no MCP servers            -> --strict-mcp-config with no --mcp-config, so
#                                  offlocal/sidetap/xapi/dashclaw-local (email,
#                                  SMS, phone, deploy) do not exist in-session
#   - no machine credentials    -> CLAUDE_HEADLESS_MEDITATION=1 makes the
#                                  $BASH_ENV loader skip .secrets.env, so no
#                                  Stripe/Neon/Clerk/Resend key is in any Bash env
#   - no Anthropic API key      -> unset below; the run bills the subscription
#   - behavioural limits        -> the /meditate skill forbids external actions
#                                  and stages by explicit pathspec only
export CLAUDE_HEADLESS_MEDITATION=1
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

# claude is a native Windows .exe, so MSYS rewrites any argument that starts
# with "/" into a Windows path. Without this, -p "/meditate nightly" arrives as
# "C:/Program Files/Git/meditate nightly". Verified 2026-08-11.
export MSYS_NO_PATHCONV=1

DIR="C:/Users/sandm/.claude/scripts/meditation"
LOG="$DIR/out/run.log"
mkdir -p "$DIR/out"

if [ "$(date +%u)" = "7" ]; then
  MODE="weekly"; MODEL="fable"
else
  MODE="nightly"; MODEL="opus"
fi

# WHY bypassPermissions (decision by Wes, 2026-08-11, aware of the tradeoff):
# Claude Code has a built-in "sensitive file" gate on everything under
# ~/.claude/. In a headless session it blocks EVERY write the meditation loop
# needs, and the first live run produced zero artifacts because of it. All
# narrower options were tested against a real session and FAILED:
#   --permission-mode acceptEdits              -> denied
#   --allowedTools "Write(...meditations/**)"  -> denied (Write(path) rules are
#                                                 not matched by file checks)
#   --allowedTools "Edit(...meditations/**)"   -> denied (an explicit allow rule
#                                                 does not lift the gate)
# Only bypassPermissions works. The blast radius is bounded by the four
# mitigations listed at the top of this file, not by the permission prompt.
# --allowedTools is deliberately omitted — under bypass it does not bind, so
# listing it would only mislead a reader into thinking the tools are limited.
# --strict-mcp-config with no --mcp-config = zero MCP servers. This is the one
# limit that DOES bind under bypassPermissions: a tool that was never loaded
# cannot be called, so the email/SMS/phone/deploy tools are simply absent.
CMD=(/c/Users/sandm/.local/bin/claude -p "/meditate $MODE" --model "$MODEL" --effort xhigh
  --permission-mode bypassPermissions --strict-mcp-config)

if [ -n "$MEDITATE_DRYRUN" ]; then
  echo "DRYRUN mode=$MODE model=$MODEL"
  printf '%q ' "${CMD[@]}"; echo
  exit 0
fi

TODAY="$(date +%F)"
DIGEST="C:/Users/sandm/.claude/meditations/digests/$TODAY.html"
LINE="C:/Users/sandm/.claude/meditations/digests/latest-line.txt"

{
  echo "=== run $(date '+%Y-%m-%d %H:%M:%S') mode=$MODE model=$MODEL ==="
  cd "C:/Users/sandm/.claude" && "${CMD[@]}"
  RC=$?
  echo "=== done rc=$RC ==="

  # Artifact self-check. The headless session exits 0 even when it writes
  # nothing at all — proven by the first live run, which was blocked by the
  # sensitive-file gate and still returned rc=0. So rc cannot be trusted alone.
  # Require today's digest AND a latest-line.txt touched in the last 24h,
  # because briefing.py keys the email line off that same freshness window.
  if [ ! -f "$DIGEST" ] || [ -z "$(find "$LINE" -mmin -1440 2>/dev/null)" ]; then
    echo "MEDITATION FAILED: no artifacts (want $DIGEST + fresh $LINE)"
    exit 1
  fi

  # Artifacts existing does not mean the session succeeded — it may have written
  # the digest and then failed. Propagate the session's own exit code. Kept
  # BEFORE the final echo on purpose: as the last command in this block, a
  # false test would become the script's exit status and fail every good run.
  [ "$RC" -ne 0 ] && { echo "MEDITATION FAILED: session rc=$RC"; exit "$RC"; }

  echo "=== artifacts ok: $TODAY.html + fresh latest-line.txt ==="
} >> "$LOG" 2>&1
