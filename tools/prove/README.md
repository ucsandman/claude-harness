# prove

Automates the rule "a check never observed failing has been run, not verified."
`prove` deliberately breaks the thing a check watches, confirms the check goes
red, restores the original file, and confirms the check goes green again. It
would have caught the real incident it was built for: a function shipped with
zero callers while 414 tests stayed green, because deleting the function
failed no test — the tests never watched it in the first place.

## Usage

```
node prove.cjs --check "<shell command>" --file <path> --find "<literal string>" --replace "<literal string>" [--cwd <dir>]
```

- `--check` — shell command that should currently pass (e.g. `npm test`, `node check.cjs`).
- `--file` — the file to mutate.
- `--find` — literal string that must occur at least once in `--file`.
- `--replace` — literal string to substitute for every occurrence of `--find`.
- `--cwd` — optional working directory for `--check`. Defaults to the directory containing `--file`.

Example against the bundled fixture:

```
node prove.cjs --check "node check.cjs" --file tests\fixture\target.cjs --find "a + b" --replace "a - b" --cwd tests\fixture
```

## What it does

1. Runs `--check` once as a baseline. It must pass, or `prove` refuses to continue.
2. Backs up the original bytes of `--file` (in memory and to `<file>.prove-bak`).
3. Replaces every literal occurrence of `--find` with `--replace` and writes the file.
4. Runs `--check` again, expecting it to fail.
5. Always restores the original bytes — on success, on error, and on Ctrl-C (SIGINT/SIGTERM) — deletes the backup file, then runs `--check` one more time to confirm it passes again.
6. Prints a verdict.

## Exit codes

- `0` — VERIFIED: the check went red when the file was broken, and green again after restore.
- `1` — UNVERIFIED: the check stayed green with the mutation applied. It does not watch what you think it watches.
- `2` — setup, baseline, or restore error (bad args, `--find` not present, baseline check already failing, or the restore-side rerun failed).

## Guarantee

`--file` is always restored to its original bytes before `prove` exits, whatever
the outcome — including on thrown errors and on SIGINT/SIGTERM. The `.prove-bak`
backup file exists only for the brief window while the mutation is applied and
is deleted once the restore succeeds.

## Self-test

```
node tests\run.cjs
```

Runs `prove` against `tests\fixture\target.cjs` / `tests\fixture\check.cjs` for
both a mutation the check catches and one it doesn't, and asserts the fixture
file is left byte-identical with no leftover backup either way.
