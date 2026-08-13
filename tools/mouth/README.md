# mouth

A minimal Windows text-to-speech tool for the Claude Code harness. Lets an
agent speak a short status line out loud, so the user hears "build done"
without watching the terminal.

## Why

Counterpart to `ears`: Claude can hear audio (`ears`) and see the desktop
(`deskclaw`), but had no way to speak. `mouth` closes that gap for short
spoken status updates — not narration, not long-form reading.

## Usage

`say.ps1` is not on PATH. Invoke it by its full path:

```
~/.claude/tools/mouth/say.ps1 "Build done"
~/.claude/tools/mouth/say.ps1 "Tests failed" -Voice Zira -Rate 2
~/.claude/tools/mouth/say.ps1 -List
```

Works from both `pwsh` (PowerShell 7) and `powershell.exe` (Windows
PowerShell 5) — `System.Speech` was verified 2026-08-13 to load and speak
natively in both on this machine, so no shell re-invoke shim was needed.

## Parameters

- Text (positional, required unless `-List`): the phrase to speak. Trimmed;
  empty after trim is an error. Capped at 800 characters — this tool is for
  short status lines, not narration.
- `-Voice <name>`: substring match (case-insensitive) against installed
  voice names. No match is an error; run `-List` to see what's installed.
- `-Rate <int>`: speech rate, -10 (slowest) to 10 (fastest). Default 0.
- `-List`: print installed voice names and exit 0. Ignores Text.

`.Speak()` is synchronous and blocks until the phrase finishes playing.

## Exit codes

| code | meaning |
|---|---|
| 1 | hard error: empty text, text over 800 characters, unknown voice, or a Speech API failure. |
| 0 | success. |

## Dependencies

None beyond what Windows ships: `System.Speech` (a SAPI wrapper built into
.NET Framework, and loadable from .NET on this machine).
