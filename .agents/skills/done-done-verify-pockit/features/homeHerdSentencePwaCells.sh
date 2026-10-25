#!/usr/bin/env bash
# Home's herd sentence in the installed PWA (home-quota-row.md): a loopback
# fake-Herdr stack held in each state the card speaks, the lab web export served
# on its own port, a standalone --app Chromium paired through
# window.__MUXR_LAB_PAIR__, then per cell the card is read back as text, asserted
# to carry the exact sentence (and never the old Healthy/Busy word) and run
# through pwa-check. Exit 1 on any miss.
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# Optional CELL_FILTER (a shell case pattern on the cell name) and OUT_PREFIX
# narrow a comparison run to the cells it needs.
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export).
set -u
wt=$PWD
web=$1; out=$2
lab_script=.agents/skills/done-done-verify-pockit/features/herdSentenceLab.mjs
mkdir -p "$out"
root=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache}/muxr-herd-pwa.XXXXXX")
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_PORT=$(free_port); CDP_PORT=$(free_port)
LAB_PID=; SRV_PID=; CHR_PID=
cleanup() {
  exec 3>&- 2>/dev/null || true
  for p in $CHR_PID $SRV_PID $LAB_PID; do kill "$p" 2>/dev/null; done
  for p in $CHR_PID $SRV_PID $LAB_PID; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; done
  rm -rf -- "$root"
}
trap cleanup EXIT
mkfifo "$root/lab.in"
LAB_TRANSPORT=loopback LAB_AGENTS=1 node "$lab_script" <"$root/lab.in" >"$root/lab.log" 2>&1 &
LAB_PID=$!
exec 3>"$root/lab.in"
for _ in $(seq 120); do grep -q '^lab ready' "$root/lab.log" && break; sleep 1; done
grep -q '^lab ready' "$root/lab.log" || { echo "the lab never started"; tail "$root/lab.log"; exit 1; }
echo "browser" >&3
for _ in $(seq 60); do grep -q '^browser code: ' "$root/lab.log" && break; sleep 1; done
link=$(sed -n 's/^browser code: //p' "$root/lab.log" | head -1)
[ -n "$link" ] || { echo "the lab never minted a browser link"; tail "$root/lab.log"; exit 1; }
MUXR_WEB_EXPORT_DIR="$web" MUXR_WEB_PORT=$WEB_PORT node scripts/diagnostics/application/serveWebExport.mjs >"$root/web.log" 2>&1 </dev/null &
SRV_PID=$!
for _ in $(seq 60); do curl -fsS "http://127.0.0.1:$WEB_PORT/index.html" >/dev/null 2>&1 && break; sleep 1; done
chromium --user-data-dir="$root/profile" --remote-debugging-port=$CDP_PORT --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size=393,844 --app="http://127.0.0.1:$WEB_PORT/" >"$root/chromium.log" 2>&1 </dev/null &
CHR_PID=$!
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-herd-pwa-$$"
ax() { chrome-devtools-axi "$@" 2>&1; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
id=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$id" ] && ax selectpage "$id" >/dev/null
sleep 8
standalone=$(ax eval "matchMedia('(display-mode: standalone)').matches" | head -1)
paired=$(ax eval "(async () => typeof (await window.__MUXR_LAB_PAIR__('$link')).machineId)()" | head -1)
echo "standalone: $standalone; paired: $paired"
ax eval "location.reload()" >/dev/null; sleep 10

sentence() {
  case "$1" in
    working) echo 'An agent is working. Nothing needed from you.' ;;
    waiting) echo 'An agent is waiting for your answer. Open it to reply.' ;;
    stopped) echo 'An agent stopped. Open it to see what happened.' ;;
    ready)  echo 'An agent is ready for your next message.' ;;
    none)   echo 'No agents are running. Start one below.' ;;
  esac
}
herdr() {
  case "$1" in
    working) echo working ;; waiting) echo blocked ;; stopped) echo failed ;; ready) echo idle ;; none) echo off ;;
  esac
}
# name:width:height:dpr:kind:state; font F at W x H is a viewport of W/F x H/F.
CELLS="
360-1.0:360:800:3:mobile:working
360-dark:360:800:3:mobile:working
390-1.0:390:844:3:mobile:working
390-dark:390:844:3:mobile:working
445-1.0:445:960:3:mobile:working
445-dark:445:960:3:mobile:working
270-1.0:270:594:2:mobile:working
270-dark:270:594:2:mobile:working
270-2.0:135:297:4:mobile:working
270-2.0-dark:135:297:4:mobile:working
1280:1280:800:1:desktop:working
1280-dark:1280:800:1:desktop:working
1440:1440:900:1:desktop:working
1440-dark:1440:900:1:desktop:working
waiting-390:390:844:3:mobile:waiting
waiting-1280-dark:1280:800:1:desktop:waiting
stopped-390:390:844:3:mobile:stopped
stopped-1280-dark:1280:800:1:desktop:stopped
ready-390:390:844:3:mobile:ready
ready-1280-dark:1280:800:1:desktop:ready
none-390:390:844:3:mobile:none
none-1280-dark:1280:800:1:desktop:none
"
misses=0
current=
shoot() { if [ "$1" = mobile ]; then ax emulate --viewport "$2x$3x$4,mobile,touch" --color-scheme "$5" >/dev/null; else ax emulate --viewport "$2x$3x$4" --color-scheme "$5" >/dev/null; fi; }
for cell in $CELLS; do
  IFS=: read -r nm w h dpr kind state <<<"$cell"
  # CELL_FILTER (an extended regex) and OUT_PREFIX let a comparison run take
  # only the cells it needs.
  if [ -n "${CELL_FILTER:-}" ] && ! [[ $nm =~ $CELL_FILTER ]]; then continue; fi
  theme=light; case "$nm" in *dark) theme=dark ;; esac
  if [ "$state" != "$current" ]; then
    echo "1 $(herdr "$state")" >&3
    current=$state
    for _ in $(seq 40); do grep -q "^set: .* $(herdr "$state")$" "$root/lab.log" && break; sleep 0.5; done
    sleep 3
  fi
  shoot "$kind" "$w" "$h" "$dpr" "$theme"
  ax eval "location.assign('/')" >/dev/null
  want=$(sentence "$state")
  seen=
  for _ in $(seq 40); do
    body=$(ax eval "document.body.innerText" | head -1)
    case "$body" in *"$want"*) seen=yes; break ;; esac
    sleep 1
  done
  shoot "$kind" "$w" "$h" "$dpr" "$theme"; sleep 3
  name="home-herd-${OUT_PREFIX:-}$nm"
  ax screenshot "$out/$name.png" >/dev/null
  text=$(ax eval "document.body.innerText.replace(/\\n/g, ' | ')" | head -1)
  node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" >"$out/$name.check.txt" 2>&1
  verdict=$(grep -E "^(clean|DEFECT|FAIL)" <"$out/$name.check.txt" | head -1)
  card=$(grep -c "Right now\.\|An agent \|No agents are running" <"$out/$name.check.txt" || true)
  echo "$name: sentence=${seen:-MISSING} check=$verdict card-leads=$card" | tee -a "$out/lines.log"
  # One text file for every cell: the innerText repeats across widths and themes,
  # and a finished run refuses byte-identical copies.
  printf '%s\t%s\n' "$name" "$text" >> "$out/cells.txt"
  [ -n "$seen" ] || misses=$((misses + 1))
  case "$text" in *Healthy*|*Busy*) echo "$name: the old machine word is still on screen" | tee -a "$out/lines.log"; misses=$((misses + 1)) ;; esac
  # The card's own line fails the cell; Home's other leads (its header, the
  # floating composer over the list, the space name's ellipsis) pre-exist on
  # main and stay in the cell's .check.txt for the self-review.
  [ "$card" = 0 ] || misses=$((misses + 1))
done
echo "standalone=$standalone paired=$paired misses=$misses"
[ "$standalone" != "${standalone%true*}" ] && [ "$misses" -eq 0 ]
