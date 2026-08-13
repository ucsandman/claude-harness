"""ears — a generic audio ear for the Claude Code harness.

Hears any audio/video file: transcribes it (local faster-whisper), measures
loudness and silence (ffmpeg), and renders a waveform+spectrogram picture so an
agent can SEE the audio. Extracted 2026-08-13 from the animations repo's
ear-gate (judge-audio); the repo-specific manifest checks stayed there, this is
the portable capability.

Verbs:
  transcribe <file...>   JSON on stdout, same contract judge-audio.mjs expects:
                         {"model":"small","files":{"<arg>":{duration,language,
                         segments:[{start,end,text}],words:[{w,start,end}]}}}
                         Results are cached in state/heard/ keyed on
                         path+size+mtime+model+hint; --no-cache forces a fresh
                         run. --hint <words> biases whisper toward names it
                         would otherwise mangle (whisper initial_prompt).
                         MEASURED tradeoff (sidetap launch video, 2026-08-13):
                         a short prose hint made whisper hear the brand word
                         "SideTap" (default decode heard nothing there), but a
                         bare glossary-style hint threw the decoder into an
                         "I, I, I..." repetition loop that ate 30s of
                         transcript on VO containing spelled-out letters
                         ("U I"). Hints are opt-in, phrased as a sentence, and
                         verified against the audio — never a default.
  hear <file>            Human/agent-readable transcript with timestamps.
                         Takes --hint too.
  levels <file>          JSON: stream facts, ebur128 loudness, silence edges.
  picture <file> [--out] Waveform over spectrogram PNG. Prints path and bytes,
                         never image content (the deskclaw rule).

Exit codes (the judge-audio contract):
  2  faster_whisper or its model unavailable (callers degrade, not die)
  1  hard error (bad usage, missing file, ffmpeg/ffprobe failure)
  0  success

faster-whisper model "small", device cpu, compute int8 — verified working on
this machine (see animations docs/superpowers/specs/2026-08-12-judge-audio-design.md
"Verified facts"). openai-whisper is BROKEN here (NumPy 2.4 vs numba) — never
import it. Model load is ~15.7s, so the model loads ONCE per process and every
requested file rides that load; the cache exists because of that same cost.

Decode settings are faster-whisper defaults ON PURPOSE (measured 2026-08-13 on
an 88s launch video): two default runs were byte-identical (deterministic —
the temperature fallback only fires on low-confidence audio), and every pinned
variant tried (temperature=0 + condition_on_previous_text=False, with and
without hints) transcribed the same or worse. Don't pin decode params without
re-running that comparison.
"""

import hashlib
import json
import os
import re
import subprocess
import sys

HOME = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HOME, "state")
MODEL = "small"
SILENCE_NOISE_DB = -35  # matches the animations ear-gate
SILENCE_MIN_D = 0.3
EDGE_EPS_S = 0.05

# ---------------------------------------------------------------------------
# Pure helpers (tested by tests/run.py)
# ---------------------------------------------------------------------------


def cache_key(path_abs, size, mtime_ns, model=MODEL, hint=""):
    """Everything that changes the transcript is in the key: a MODEL bump or a
    different --hint must be a cache MISS, or a stale transcript gets served as
    if it came from the current configuration."""
    raw = f"{path_abs}|{size}|{mtime_ns}|{model}|{hint or ''}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def take_opt(argv, name):
    """Pop '--name value' from argv. Returns (value_or_None, remaining_args)."""
    argv = list(argv)
    if name in argv:
        i = argv.index(name)
        if i + 1 >= len(argv):
            die(f"{name} needs a value")
        value = argv[i + 1]
        del argv[i : i + 2]
        return value, argv
    return None, argv


def parse_ebur128(text):
    i = re.search(r"^\s*I:\s*(-?[\d.]+) LUFS", text, re.M)
    lra = re.search(r"^\s*LRA:\s*(-?[\d.]+) LU", text, re.M)
    peak = re.search(r"^\s*Peak:\s*(-?[\d.]+) dB(?:TP|FS)", text, re.M)
    if not (i and lra and peak):
        return None
    return {
        "integratedLufs": float(i.group(1)),
        "lra": float(lra.group(1)),
        "truePeakDb": float(peak.group(1)),
    }


def parse_silence_events(text):
    starts = [
        float(m.group(1)) for m in re.finditer(r"silence_start:\s*([\d.-]+)", text)
    ]
    ends = [
        (float(m.group(1)), float(m.group(2)))
        for m in re.finditer(
            r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", text
        )
    ]
    events = []
    for idx in range(min(len(starts), len(ends))):
        events.append(
            {"startS": starts[idx], "endS": ends[idx][0], "durationS": ends[idx][1]}
        )
    return events


def edge_silence(events, duration_s):
    """Leading/trailing digital silence from silencedetect events."""
    leading = 0.0
    trailing = 0.0
    if events:
        first, last = events[0], events[-1]
        if first["startS"] <= EDGE_EPS_S:
            leading = first["durationS"]
        if duration_s and last["endS"] >= duration_s - EDGE_EPS_S:
            trailing = duration_s - last["startS"]
    return {"leadingS": round(leading, 3), "trailingS": round(trailing, 3)}


def parse_ffprobe_streams(parsed):
    streams = parsed.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = parsed.get("format") or {}
    duration = fmt.get("duration")
    return {
        "hasAudio": audio is not None,
        "durationS": float(duration) if duration is not None else None,
        "audioDurationS": float(audio["duration"])
        if audio and audio.get("duration")
        else None,
        "sampleRate": int(audio["sample_rate"])
        if audio and audio.get("sample_rate")
        else None,
        "codec": audio.get("codec_name") if audio else None,
    }


# ---------------------------------------------------------------------------
# Impure helpers
# ---------------------------------------------------------------------------


def die(msg, code=1):
    print(f"ears: {msg}", file=sys.stderr)
    sys.exit(code)


def require_file(path):
    if not os.path.isfile(path):
        die(f"no such file: {path}")
    return os.path.abspath(path)


def run(cmd):
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )


def ffprobe(path_abs):
    res = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=index,codec_type,codec_name,sample_rate,duration",
            "-of",
            "json",
            path_abs,
        ]
    )
    if res.returncode != 0:
        die(f"ffprobe failed on {path_abs}:\n{res.stderr}")
    return parse_ffprobe_streams(json.loads(res.stdout))


def transcribe_files(args, use_cache=True, hint=None):
    """Returns the judge-audio JSON contract dict. Loads whisper only on a cache miss.

    Decode parameters are faster-whisper's defaults ON PURPOSE: measured
    deterministic on this machine (two runs on an 88s video, byte-identical
    segments) and the most accurate configuration tested. `hint` becomes
    whisper's initial_prompt — see verb_transcribe's usage text for the
    measured tradeoffs before reaching for it.
    """
    os.makedirs(os.path.join(STATE, "heard"), exist_ok=True)
    result = {"model": MODEL, "files": {}}
    misses = []
    for arg in args:
        path_abs = require_file(arg)
        st = os.stat(path_abs)
        cpath = os.path.join(
            STATE,
            "heard",
            cache_key(path_abs, st.st_size, st.st_mtime_ns, MODEL, hint) + ".json",
        )
        if use_cache and os.path.isfile(cpath):
            try:
                with open(cpath, "r", encoding="utf-8") as f:
                    result["files"][arg] = json.load(f)["data"]
                continue
            except Exception:
                pass  # corrupt cache entry: fall through to a fresh transcribe
        misses.append((arg, path_abs, cpath))

    if misses:
        try:
            from faster_whisper import WhisperModel
        except Exception as exc:
            die(f"faster_whisper unavailable: {exc}", 2)
        try:
            model = WhisperModel(MODEL, device="cpu", compute_type="int8")
        except Exception as exc:
            die(f"model load failed: {exc}", 2)
        for arg, path_abs, cpath in misses:
            try:
                segments, info = model.transcribe(
                    path_abs, word_timestamps=True, initial_prompt=hint or None
                )
                seg_list, word_list = [], []
                for seg in segments:
                    seg_list.append(
                        {"start": seg.start, "end": seg.end, "text": seg.text.strip()}
                    )
                    for w in seg.words or []:
                        word_list.append(
                            {"w": w.word.strip(), "start": w.start, "end": w.end}
                        )
                data = {
                    "duration": info.duration,
                    "language": info.language,
                    "segments": seg_list,
                    "words": word_list,
                }
            except Exception as exc:
                die(f"failed to transcribe {arg}: {exc}")
            result["files"][arg] = data
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump({"path": path_abs, "model": MODEL, "data": data}, f)
    return result


# ---------------------------------------------------------------------------
# Verbs
# ---------------------------------------------------------------------------


def verb_transcribe(argv):
    hint, argv = take_opt(argv, "--hint")
    use_cache = "--no-cache" not in argv
    files = [a for a in argv if not a.startswith("--")]
    if not files:
        die("usage: ears transcribe <file> [<file> ...] [--no-cache] [--hint <words>]")
    print(json.dumps(transcribe_files(files, use_cache, hint)))


def verb_hear(argv):
    hint, argv = take_opt(argv, "--hint")
    files = [a for a in argv if not a.startswith("--")]
    if len(files) != 1:
        die("usage: ears hear <file> [--hint <words>]")
    data = transcribe_files(files, hint=hint)["files"][files[0]]
    print(
        f"{files[0]}  duration {data['duration']:.1f}s  language {data['language']}  model {MODEL}"
    )
    if not data["segments"]:
        print("(no speech recognized)")
    for seg in data["segments"]:
        print(f"[{seg['start']:7.2f}-{seg['end']:7.2f}] {seg['text']}")


def verb_levels(argv):
    files = [a for a in argv if not a.startswith("--")]
    if len(files) != 1:
        die("usage: ears levels <file>")
    path_abs = require_file(files[0])
    streams = ffprobe(path_abs)
    out = {"file": files[0], **streams, "loudness": None, "silence": None}
    if streams["hasAudio"]:
        res = run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostats",
                "-i",
                path_abs,
                "-af",
                "ebur128=peak=true:framelog=quiet",
                "-f",
                "null",
                "-",
            ]
        )
        out["loudness"] = parse_ebur128((res.stdout or "") + (res.stderr or ""))
        res = run(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostats",
                "-i",
                path_abs,
                "-af",
                f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_D}",
                "-f",
                "null",
                "-",
            ]
        )
        events = parse_silence_events((res.stdout or "") + (res.stderr or ""))
        out["silence"] = {
            **edge_silence(events, streams["durationS"]),
            "events": len(events),
        }
    print(json.dumps(out, indent=1))


def verb_picture(argv):
    files = [a for a in argv if not a.startswith("--")]
    if len(files) != 1:
        die("usage: ears picture <file> [--out <png>]")
    path_abs = require_file(files[0])
    if "--out" in argv:
        out_png = os.path.abspath(argv[argv.index("--out") + 1])
    else:
        os.makedirs(os.path.join(STATE, "pictures"), exist_ok=True)
        stem = os.path.splitext(os.path.basename(path_abs))[0]
        out_png = os.path.join(STATE, "pictures", f"{stem}.png")
    w, wave_h, spec_h = 1600, 260, 260
    filters = (
        f"[0:a]showwavespic=s={w}x{wave_h}:colors=white[wave];"
        f"[0:a]showspectrumpic=s={w}x{spec_h}:legend=disabled[spec];"
        "[wave][spec]vstack=inputs=2[out]"
    )
    res = run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            path_abs,
            "-filter_complex",
            filters,
            "-frames:v",
            "1",
            "-map",
            "[out]",
            out_png,
        ]
    )
    if res.returncode != 0 or not os.path.isfile(out_png):
        die(f"picture render failed:\n{res.stderr}")
    print(f"{out_png}  {os.path.getsize(out_png)} bytes")


VERBS = {
    "transcribe": verb_transcribe,
    "hear": verb_hear,
    "levels": verb_levels,
    "picture": verb_picture,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in VERBS:
        die(f"usage: ears <{'|'.join(VERBS)}> ...")
    VERBS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
