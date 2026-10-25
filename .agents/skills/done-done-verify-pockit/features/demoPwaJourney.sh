#!/usr/bin/env bash
# Records the demo-first run in the installed PWA: first open, a sample
# conversation, back, and the Pair your own computer step opening the real
# pairing screen. Frames are sampled with the same screenshot command the
# matrix uses, each stamped as it is taken, so the clip keeps the real pacing;
# it is a sample, not a frame-rate measurement. Then it checks the run really
# ended on /pair.
#   CHROME_DEVTOOLS_AXI_BROWSER_URL=<devtools> [VIEWPORT=390x844x2,mobile,touch]
#   [THEME=dark] [MUXR_DEMO_URL=http://127.0.0.1:<port>/] demoPwaJourney.sh <outDir>
#   (from the repo root)
set -u
out=$1
mkdir -p "$out"
rm -f "$out"/frame-*.png "$out"/frames.txt
shot() {
  local index
  index=$(printf %04d "$(ls "$out"/frame-*.png 2>/dev/null | wc -l)")
  chrome-devtools-axi screenshot "$out/frame-$index.png" >/dev/null 2>&1
  if [ ! -f "$out/frame-$index.png" ]; then
    echo "no screenshot for frame-$index: is the browser still on the export?"
    exit 1
  fi
  date +%s%3N >> "$out"/stamps.txt
}
frames() { for _ in $(seq 1 "$1"); do shot; done; }
scroll='(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight * FACTOR; return "scrolled"; })()'
rm -f "$out"/stamps.txt
viewport=${VIEWPORT:-390x844x2,mobile,touch}
theme=${THEME:-dark}
# A fresh browser has no selected page, and every command below acts on the
# selected one: open the export, then select that tab explicitly (a browser
# holding two tabs selects neither by itself).
chrome-devtools-axi open "${MUXR_DEMO_URL:-http://127.0.0.1:8911/}" >/dev/null 2>&1
sleep 1
page=$(chrome-devtools-axi pages 2>/dev/null | awk -F, '{print $1}' | tail -1 | tr -d ' ')
[ -n "$page" ] && chrome-devtools-axi selectpage "$page" >/dev/null 2>&1
# A reload drops the emulation, so it goes on again once the shell has drawn.
chrome-devtools-axi emulate --viewport "$viewport" --color-scheme "$theme" >/dev/null 2>&1
sleep 3
chrome-devtools-axi emulate --viewport "$viewport" --color-scheme "$theme" >/dev/null 2>&1
drawn=$(chrome-devtools-axi eval "document.body.innerText.trim().length" 2>&1 | sed -n 's/^result: "\([0-9]*\)"$/\1/p' | head -1)
if [ "${drawn:-0}" = "0" ]; then
  echo "the page has not drawn yet: nothing to record"
  exit 1
fi
frames 12
chrome-devtools-axi eval "document.querySelector('[role=button][aria-label^=\"zulu-2\"]').click()" >/dev/null 2>&1
sleep 1
frames 4
chrome-devtools-axi eval "${scroll/FACTOR/1}" >/dev/null 2>&1
frames 6
chrome-devtools-axi eval "${scroll/FACTOR/0}" >/dev/null 2>&1
frames 5
chrome-devtools-axi eval "document.querySelector('[role=button][aria-label=\"Back to all demo agents\"]').click()" >/dev/null 2>&1
frames 5
chrome-devtools-axi eval "document.querySelector('[role=button][aria-label=\"Pair your own computer\"]').click()" >/dev/null 2>&1
sleep 2
frames 8

# ffmpeg concat list with each frame's real on-screen time.
count=$(ls "$out"/frame-*.png | wc -l)
stamps=($(cat "$out"/stamps.txt))
: > "$out"/frames.txt
for index in $(seq 0 $((count - 1))); do
  name=$(printf 'frame-%04d.png' "$index")
  next=${stamps[$((index + 1))]:-$(date +%s%3N)}
  seconds=$(awk "BEGIN{printf \"%.3f\", (${next} - ${stamps[$index]}) / 1000}")
  printf "file '%s'\nduration %s\n" "$name" "$seconds" >> "$out"/frames.txt
done
printf "file '%s'\n" "$(printf 'frame-%04d.png' $((count - 1)))" >> "$out"/frames.txt
seconds=$(awk "BEGIN{printf \"%.2f\", (${stamps[$((count - 1))]} - ${stamps[0]}) / 1000}")
path=$(chrome-devtools-axi eval "location.pathname" 2>&1 | sed -n 's/^result: "\(.*\)"$/\1/p' | head -1 | tr -d '\\"')
echo "frames=$count sampled over ${seconds}s"
if [ "$path" != "/pair" ]; then
  echo "journey ended on ${path:-no page}, not /pair"
  exit 1
fi
