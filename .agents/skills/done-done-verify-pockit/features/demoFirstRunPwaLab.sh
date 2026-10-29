#!/usr/bin/env bash
# The demo an unpaired browser lands on (pwa-demo-first-run.md), captured from
# one owned lab: the export served on its own free port, a standalone --app
# Chromium on a private display, then the matrix (demoFirstRunPwaCells.sh) and
# the clip from first open into the My computer pair step (demoPwaJourney.sh) in one run, encoded to
# demo-first-run.mp4 with each frame's real on-screen time. Exit 1 when a cell
# fails or the clip does not end on /my-computer.
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# The export comes from `yarn web:export`; no relay, host or Herdr is needed,
# nothing pairs, and no grant may be stored in the profile.
set -u
wt=$PWD
web=$1; out=$2
mkdir -p "$out"
d=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache}/muxr-demo-pwa.XXXXXX")
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_PORT=$(free_port); CDP_PORT=$(free_port)
SRV_PID=; CHR_PID=
cleanup() {
  for p in $CHR_PID $SRV_PID; do kill "$p" 2>/dev/null; done
  for p in $CHR_PID $SRV_PID; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; done
  rm -rf -- "$d"
}
trap cleanup EXIT
MUXR_WEB_EXPORT_DIR="$web" MUXR_WEB_PORT=$WEB_PORT node scripts/diagnostics/application/serveWebExport.mjs >"$d/web.log" 2>&1 </dev/null &
SRV_PID=$!
for _ in $(seq 60); do curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break; sleep 1; done
chromium --user-data-dir="$d/profile" --remote-debugging-port=$CDP_PORT --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size=390,844 --app="http://127.0.0.1:$WEB_PORT/" >"$d/chromium.log" 2>&1 </dev/null &
CHR_PID=$!
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-demo-pwa-$$"
export MUXR_DEMO_URL="http://127.0.0.1:$WEB_PORT/"
ax() { chrome-devtools-axi "$@" 2>&1; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
page=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$page" ] || { echo "the app window never appeared"; tail "$d/chromium.log"; exit 1; }
ax selectpage "$page" >/dev/null
# A fresh profile has no pairing grant, which is the state this screen is for.
paired=$(ax eval "document.body.innerText.includes('Sample data')" | head -1)
echo "unpaired demo shown: $paired"

bash "$wt/.agents/skills/done-done-verify-pockit/features/demoFirstRunPwaCells.sh" "$out"
cells=$?
ax emulate --viewport 390x844x2,mobile,touch --color-scheme dark >/dev/null 2>&1
bash "$wt/.agents/skills/done-done-verify-pockit/features/demoPwaJourney.sh" "$out/journey-frames"
clip=$?
ffmpeg -y -loglevel error -f concat -safe 0 -i "$out/journey-frames/frames.txt" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$out/demo-first-run.mp4"
if [ -f "$out/demo-first-run.mp4" ]; then
  echo "clip: $out/demo-first-run.mp4 $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/demo-first-run.mp4")s"
else
  clip=1
fi
version=$(node -p "require('./package.json').version")
cat > "$out/steps.json" <<JSON
{
  "target": {"version": "$version"},
  "start": "a fresh browser profile with no computer paired",
  "steps": [
    "open the web export in the app window at 390 dp, dark",
    "read the demo: the Sample data pill, Umer's MacBook Pro and zulu-2, kestrel and ember in order",
    "open the first agent's sample conversation and scroll it",
    "go back to all demo agents",
    "tap Connect a machine, then the My computer door, then Next: pair"
  ],
  "result": "the My computer pair step: Pair with your computer, its Private link or pairing code field and Connect"
}
JSON
echo "cells exit $cells, clip exit $clip"
[ "$cells" -eq 0 ] && [ "$clip" -eq 0 ]
