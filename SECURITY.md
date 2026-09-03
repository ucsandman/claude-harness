# Security

## Reporting

If you find a credential, a private path that should not be public, personal
data, or a guard bypass that matters, please report it privately rather than
in a public issue. Use GitHub's private vulnerability reporting on this repo
(Security tab, "Report a vulnerability"). You will get a reply within a few
days and a note in the changelog once it is handled.

## What this repo promises

- No credentials, ever. The private source repo never held any, and each sync
  runs a sweep over every file for key shapes, bearer tokens, credentialed
  URLs, `key=value` secrets, emails and phone numbers. The sweep prints the
  number of files it scanned beside its verdict, so an empty result on zero
  files cannot pass as clean.
- Test fixtures that contain fake key shapes live only under a `tests/`
  directory and exist to prove redaction works.
- The agent's memory store, the identity file's real content, and the
  machine's trust-boundary description are not in this mirror.

## What this repo does not promise

The guards here are defence in depth for one operator's machine, not a
security product. They see Claude Code's own tool calls and this machine's git
commits. They do not see commands typed in a terminal, other agents' actions
outside the adapters, or anything the model reads rather than writes. Treat
them as a floor, not a boundary.
