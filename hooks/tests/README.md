# Guard probes

Regression tests for the harness guard hooks. Each probe asserts BOTH directions:
the payload that must be denied, and the payload that must still be allowed — so a
green run proves the guard works, not that it blocks everything.

    node hooks/tests/guard-probe.cjs        # secret-guard + process-kill-guard   (7 checks)
    node hooks/tests/fanout-probe.cjs       # agent-model-guard fan-out rule      (5 checks)
    node hooks/tests/wiredark-probe.cjs     # tools/wiredark: new export, no caller (14 checks, scratch git repo)
    node hooks/tests/gate-freeze-probe.cjs  # gate-freeze deny + hash drift        (20 checks)
    node hooks/tests/slopsquat-guard-probe.cjs  # package names verified on npm/PyPI/crates (33 checks, live registries)

Both exit nonzero on failure.

Every check here was watched failing on purpose before it was trusted (rule L1).
The bypasses they pin, all found and fixed 2026-08-16:

- **secret-guard** was registered on `PowerShell` but had no PowerShell case in its
  switch, so it fell to `default: exit(0)`. Every key/PEM/entropy scan and the
  git-add-a-.env block was a no-op on half the tool surface.
- **process-kill-guard**'s lookahead `[^|;\r\n]*?` could not see past a semicolon,
  so assigning the cmdlet name to a variable in one statement and invoking it with
  `-Name` in the next slipped through.
- **agent-model-guard** required a Fable call's character offset to sit inside a
  fan-out construct's text span; hoisting the call into a helper declared outside
  the loop defeated it, and the per-call-site cap missed it too.

## Note when editing these files

The probes necessarily contain the exact payloads the guards block. Building those
strings by concatenation (as the probes do) keeps them from tripping the guards on
the way in. Writing a literal payload into a shell heredoc will be denied by
process-kill-guard — that is the guard working, not a bug. Use a file-write tool.

## Confirming a probe still bites

Never trust a green run you have not seen fail. Copy the guard, break the copy,
point the probe at it, and confirm the count drops. Restore by deleting the copy.

## Related self-checks

    node tools/spend/spend.cjs --selftest       # 32 — pricing arithmetic + turn dedup
    node tools/gitradar/gitradar.cjs --selftest # 15 — git-failure vs zero-commits
    node tools/errorlog/errorlog.cjs --selftest # 17 — deviation parsing + bucketing
