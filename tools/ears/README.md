# ears

A generic audio ear for the Claude Code harness. Hears any audio/video file on
this machine: transcribes it locally, measures loudness and silence, and renders
a waveform+spectrogram picture so an agent can see the audio.

Extracted 2026-08-13 from the animations repo's ear-gate. The portable
capability (whisper sidecar + ffmpeg checks) lives here; the repo-specific
manifest/timing/duck checks stayed in `C:\Projects\animations\scripts\judge-audio.mjs`,
which now delegates its transcription to this tool through
`feeders/audio/transcribe.py` (override the location with `EARS_HOME`).
Origin spec: `animations/docs/superpowers/specs/2026-08-12-judge-audio-design.md`.

## Verbs

`ears` is not on PATH. Invoke it by its full path (the bash wrapper keeps rtk
coverage), or `python ears.py <verb>` directly:

```bash
~/.claude/tools/ears/ears hear <file>              # transcript with timestamps
~/.claude/tools/ears/ears transcribe <file...>     # JSON: segments + word timestamps
~/.claude/tools/ears/ears levels <file>            # JSON: duration, LUFS, true peak, silence edges
~/.claude/tools/ears/ears picture <file> [--out p] # waveform+spectrogram PNG; prints path + bytes
```

`hear` and `transcribe` take `--hint "<words>"` — whisper's initial_prompt, for
brand names it otherwise mangles ("SideTap" → "PsyTep", "paperoute" →
"paperoot"). Opt-in only, measured 2026-08-13: a short prose hint recovered the
brand word; a bare glossary hint threw the decoder into a repetition loop on
spelled-out letters ("U I") and ate 30s of transcript. Phrase the hint as a
sentence and check the result against the audio.

`transcribe` emits exactly the contract `judge-audio.mjs` consumes:
`{"model":"small","files":{"<arg>":{duration,language,segments,words}}}`.

## Facts (measured; do not re-derive)

- faster-whisper model `small`, cpu int8 (faster-whisper 1.2.1). Cold run on a
  74s video: ~25s (model load ~16s dominates). Cached re-run: **0.2s**.
  Transcripts cache in `state/heard/` keyed on path+size+mtime+model+hint —
  anything that changes the transcript is in the key; `--no-cache` forces a
  fresh run.
- Default decode is DETERMINISTIC (two runs on an 88s video, byte-identical
  segments) and was the most accurate configuration tested; pinned variants
  (`temperature=0`, `condition_on_previous_text=False`) came out the same or
  worse. Don't pin decode params without re-running that comparison.
- **openai-whisper is BROKEN on this machine** (NumPy 2.4 vs numba). Never
  import it. faster_whisper works but torch prints NumPy 1.x/2.x warnings on
  stderr at import — noise, not failure; stdout stays clean JSON.
- ffmpeg 9 (gyan.dev) on PATH provides `ebur128`, `silencedetect`,
  `showwavespic`, `showspectrumpic`. Remotion's bundled ffmpeg does NOT.
- `silencedetect` at -35dB hears music as sound: it finds leading/trailing
  digital silence, but it can NOT find speechless stretches under music. Gaps
  in the transcript's word timestamps find those (this is why `hear` shows
  timestamps).

## Exit codes

| code | meaning |
|---|---|
| 2 | faster_whisper or its model unavailable. Callers degrade instead of dying (the judge-audio contract). |
| 1 | hard error: bad usage, missing file, ffmpeg/ffprobe failure. |
| 0 | success. |

## Safety

- Pictures and transcripts are written to `state/` (gitignored); the tool never
  writes outside its own directory except via an explicit `--out`.
- `picture` prints a path and a byte count, never image content — reading the
  PNG is a separate, deliberate act (the deskclaw rule).
- CLI-only is a recorded decision (CLAUDE.md §5): the consumer of this tool is
  the agent; the human-visible artifacts are the transcript text and the PNG.
  If a human surface is ever wanted, it belongs in the deskclaw viewer, not a
  second page.

## Tests

`python tests/run.py` — pure helpers (ffmpeg output parsers, silence-edge
derivation, cache keys). The runner exits 1 on any failure (verified by
breaking an assertion on purpose).
