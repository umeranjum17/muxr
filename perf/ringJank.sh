#!/usr/bin/env bash
# Command ring open/close frames on a physical Android device.
# usage: perf/ringJank.sh <serial> <package> <cycles> <label>
#
# Precondition: the app sits on the terminal screen of an idle pane, ring
# closed, composer empty. Taps the floating control open and closed <cycles>
# times, all on-device so adb adds no jitter, then reports gfxinfo for that
# window AND splits framestats into ring frames (within 400 ms of a tap)
# and idle terminal frames outside tap windows.
# gfxinfo's "Janky frames" counts both; only the first population is the ring.
# See docs/perf/command-ring-frames.md.
set -euo pipefail
serial=$1 pkg=$2 cycles=$3 label=$4
out=${RING_JANK_OUT:-/tmp/ring-jank}; mkdir -p "$out"
a() { adb -s "$serial" "$@"; }
a shell uiautomator dump /sdcard/ring.xml >/dev/null
bounds=$(a shell cat /sdcard/ring.xml | grep -o 'content-desc="Terminal quick actions"[^>]*bounds="[^"]*"' | grep -o 'bounds="[^"]*"' | head -1 || true)
a shell rm -f /sdcard/ring.xml
[ -n "$bounds" ] || { echo "floating control not on screen" >&2; exit 1; }
read -r x1 y1 x2 y2 <<< "$(echo "$bounds" | grep -o '[0-9]\+' | tr '\n' ' ')"
x=$(( (x1 + x2) / 2 )) y=$(( (y1 + y2) / 2 ))
a shell dumpsys gfxinfo "$pkg" reset >/dev/null
a shell "for i in \$(seq $cycles); do input tap $x $y; sleep 0.8; input tap $x $y; sleep 0.8; done"
a shell dumpsys gfxinfo "$pkg" framestats > "$out/$label.txt"
echo "== $label ($serial, $(a shell getprop ro.product.model | tr -d '\r'))"
grep -E "Total frames rendered|Janky frames:|99th percentile:" "$out/$label.txt" | head -3
# framestats keeps the last 120 frames only; the split is over those.
python3 - "$out/$label.txt" <<'PY'
import sys
rows, hdr = [], None
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith('Flags,'): hdr = line.rstrip(',').split(','); continue
    if hdr and line[:1].isdigit():
        v = line.rstrip(',').split(',')
        if len(v) >= len(hdr): rows.append(dict(zip(hdr, map(int, v[:len(hdr)]))))
rows = sorted((r for r in rows if r['Flags'] == 0), key=lambda r: r['IntendedVsync'])
ring, idle = [], []
last_tap = None
for r in rows:
    if r['InputEventId']:
        last_tap = r['IntendedVsync']
    (ring if last_tap is not None and r['IntendedVsync'] - last_tap <= 400_000_000 else idle).append(r)
late = lambda xs: sum(r['FrameCompleted'] > r['FrameDeadline'] for r in xs)
print(f'ring frames {len(ring)} late {late(ring)} | idle terminal frames {len(idle)} late {late(idle)}')
PY
