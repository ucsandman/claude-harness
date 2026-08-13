"""Zero-dependency tests for ears' pure helpers. Run: python tests/run.py"""

import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location(
    "ears", os.path.join(os.path.dirname(__file__), "..", "ears.py")
)
ears = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ears)

failures = []


def check(name, cond):
    if cond:
        print(f"ok    {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}")


# --- parse_ebur128 (shape of real ffmpeg 9 stderr Summary block) ---
EBUR = """  Integrated loudness:
    I:         -16.2 LUFS
    Threshold: -26.9 LUFS

  Loudness range:
    LRA:         6.4 LU
    Threshold: -36.8 LUFS
    LRA low:   -20.5 LUFS
    LRA high:  -14.1 LUFS

  True peak:
    Peak:       -1.3 dBTP
"""
parsed = ears.parse_ebur128(EBUR)
check(
    "ebur128 parses I/LRA/Peak",
    parsed == {"integratedLufs": -16.2, "lra": 6.4, "truePeakDb": -1.3},
)
check("ebur128 returns None on garbage", ears.parse_ebur128("no summary here") is None)

# --- parse_silence_events ---
SIL = """[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 0.52 | silence_duration: 0.52
[silencedetect @ 0x1] silence_start: 72.54
[silencedetect @ 0x1] silence_end: 73.8 | silence_duration: 1.26
"""
events = ears.parse_silence_events(SIL)
check("silencedetect finds 2 events", len(events) == 2)
check(
    "silencedetect first event",
    events[0] == {"startS": 0.0, "endS": 0.52, "durationS": 0.52},
)
check("silencedetect empty input", ears.parse_silence_events("") == [])

# --- edge_silence ---
edges = ears.edge_silence(events, 73.8)
check("leading silence from t=0 event", edges["leadingS"] == 0.52)
check("trailing silence reaches file end", abs(edges["trailingS"] - 1.26) < 0.01)
mid = [{"startS": 30.0, "endS": 31.0, "durationS": 1.0}]
edges2 = ears.edge_silence(mid, 73.8)
check("interior event is neither edge", edges2 == {"leadingS": 0.0, "trailingS": 0.0})
check(
    "no events, no edges",
    ears.edge_silence([], 73.8) == {"leadingS": 0.0, "trailingS": 0.0},
)

# --- parse_ffprobe_streams ---
PROBE = {
    "streams": [
        {
            "index": 0,
            "codec_type": "video",
            "codec_name": "h264",
            "duration": "73.766667",
        },
        {
            "index": 1,
            "codec_type": "audio",
            "codec_name": "aac",
            "sample_rate": "48000",
            "duration": "73.813333",
        },
    ],
    "format": {"duration": "73.813333"},
}
st = ears.parse_ffprobe_streams(PROBE)
check("ffprobe hasAudio + rate", st["hasAudio"] and st["sampleRate"] == 48000)
check("ffprobe duration from format", abs(st["durationS"] - 73.813333) < 1e-6)
check(
    "ffprobe no-audio file",
    ears.parse_ffprobe_streams({"streams": [], "format": {}})["hasAudio"] is False,
)

# --- cache_key ---
k1 = ears.cache_key("C:/x/a.mp4", 100, 200)
check("cache_key stable", k1 == ears.cache_key("C:/x/a.mp4", 100, 200))
check("cache_key changes with mtime", k1 != ears.cache_key("C:/x/a.mp4", 100, 201))
check("cache_key changes with path", k1 != ears.cache_key("C:/x/b.mp4", 100, 200))
check(
    "cache_key changes with model",
    k1 != ears.cache_key("C:/x/a.mp4", 100, 200, model="large-v3"),
)
check(
    "cache_key changes with hint",
    k1 != ears.cache_key("C:/x/a.mp4", 100, 200, hint="SideTap"),
)
check(
    "cache_key hint None == hint empty",
    k1 == ears.cache_key("C:/x/a.mp4", 100, 200, hint=None),
)

# --- take_opt ---
v, rest = ears.take_opt(["a.mp4", "--hint", "SideTap words", "--no-cache"], "--hint")
check("take_opt pops value", v == "SideTap words" and rest == ["a.mp4", "--no-cache"])
v2, rest2 = ears.take_opt(["a.mp4"], "--hint")
check("take_opt absent", v2 is None and rest2 == ["a.mp4"])

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all tests passed")
