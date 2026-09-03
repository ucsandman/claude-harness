# Contributing

This repo is a public mirror of a private working setup. Changes land in the
private repo first and are synced here, so a pull request is reviewed against
the live harness rather than merged in place. That is slower than a normal
merge but keeps the mirror honest: everything here is something that actually
runs.

## What is most useful

1. **Incident reports.** "Guard X let Y through" with the exact tool input.
   The best form is a probe under `hooks/tests/` that fails today. Every guard
   in this repo started as one of those.
2. **Portability fixes.** Paths and shells are Windows-specific. A change that
   makes a hook or tool run unmodified on macOS or Linux, without a second
   copy of the logic, is welcome.
3. **Measurements.** Claims in the docs carry numbers (token costs, timings,
   counts). If you measure something different, open an issue with the method.

## Ground rules

- One change per pull request. No drive-by refactors or formatting passes.
- A guard change ships with its probe. A probe that has never been seen
  failing does not count as a test.
- Zero dependencies stays zero. Hooks and tools are single files that run on
  the stock Node, PowerShell or Python already on the machine.
- Never commit anything that looks like a credential, even a fake one, outside
  a clearly named test fixture. The pre-commit secret scan will reject it, and
  so will the sync sweep.
- Match the surrounding style. Plain prose, no marketing tone.

## Running the checks

```bash
node tools/gates/gates.cjs            # doc and wiring gates
node hooks/tests/guard-probe.cjs      # make each guard fail on purpose
node tools/prove/tests/run.cjs        # prove's own suite
```

The probes assume the hooks are registered at their `~/.claude` paths; read
the top of each probe for the environment it expects.
