#!/usr/bin/env bash
# The agent chat slice in the installed PWA (chat-view.md: chat-switch-labelled,
# chat-composer-card, chat-reply-actions, chat-side-panel): the chat fake lab
# (real relay, host and E2EE over a fake Herdr, a seeded Claude log, and the
# model Herdr reports for the pane), the lab web export on its own port, a
# standalone --app Chromium paired through window.__MUXR_LAB_PAIR__, then per
# cell (phone 360/390/445/270 at font 1.0, 270 at font 2.0, desktop 1280/1440;
# dark and light) the Claude agent in Chat: the Chat | Terminal switch in the
# header, the model chip, Copy under a reply, and on a wide screen the
# right panel. Each cell is read back as text and run through pwa-check. Exit 1
# when any cell misses one of them.
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export).
set -u
wt=$PWD
web=$1; out=$2
mkdir -p "$out"
root=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache}/muxr-chat-pwa.XXXXXX")
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_PORT=$(free_port); CDP_PORT=$(free_port)
LAB_PID=; SRV_PID=; CHR_PID=
cleanup() {
  for p in $CHR_PID $SRV_PID $LAB_PID; do kill "$p" 2>/dev/null; done
  for p in $CHR_PID $SRV_PID $LAB_PID; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; done
  rm -rf -- "$root"
}
trap cleanup EXIT
node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs)" >"$root/lab.log" 2>&1 < <(tail -f /dev/null) &
LAB_PID=$!
for _ in $(seq 120); do grep -q 'lab ready' "$root/lab.log" && break; sleep 1; done
kill -USR1 "$LAB_PID"
for _ in $(seq 30); do grep -q '^browser link:' "$root/lab.log" && break; sleep 1; done
link=$(sed -n 's/^browser link: //p' "$root/lab.log" | head -1)
[ -n "$link" ] || { echo "the lab never minted a browser link"; tail "$root/lab.log"; exit 1; }
MUXR_WEB_EXPORT_DIR="$web" MUXR_WEB_PORT=$WEB_PORT node scripts/diagnostics/application/serveWebExport.mjs >"$root/web.log" 2>&1 </dev/null &
SRV_PID=$!
chromium --user-data-dir="$root/profile" --remote-debugging-port=$CDP_PORT --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size=393,844 --app="http://127.0.0.1:$WEB_PORT/" >"$root/chromium.log" 2>&1 </dev/null &
CHR_PID=$!
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-chat-pwa-$$"
ax() { chrome-devtools-axi "$@" 2>&1; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
id=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$id" ] && ax selectpage "$id" >/dev/null
sleep 8
standalone=$(ax eval "matchMedia('(display-mode: standalone)').matches" | head -1)
paired=$(ax eval "(async () => typeof (await window.__MUXR_LAB_PAIR__('$link')).machineId)()" | head -1)
echo "standalone: $standalone; paired: $paired"
ax eval "location.reload()" >/dev/null; sleep 10
# name:width:height:dpr:kind; font F at W x H is a viewport of W/F x H/F (react-native-web pins fontScale to 1).
CELLS="360-1.0:360:800:3:mobile 390-1.0:390:844:3:mobile 445-1.0:445:960:3:mobile 270-1.0:270:594:2:mobile 270-2.0:135:297:4:mobile 1280:1280:800:1:desktop 1440:1440:900:1:desktop"
shoot() { if [ "$1" = mobile ]; then ax emulate --viewport "$2x$3x$4,mobile,touch" --color-scheme "$5" >/dev/null; else ax emulate --viewport "$2x$3x$4" --color-scheme "$5" >/dev/null; fi; }
# One DOM read per cell: the switch, the chip, Copy, and the side panel.
READ="(() => { const l = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')); const has = (re) => l.some((t) => re.test(t)); return JSON.stringify({ chat: has(/^Chat view/), terminal: has(/^Terminal view/), chip: l.find((t) => /^Model /.test(t)) ?? 'none', copy: has(/^Copy reply/), panel: document.body.innerText.includes('Shared Artifacts') && document.body.innerText.includes('All changes') }); })()"
misses=0
for theme in dark light; do for cell in $CELLS; do
  IFS=: read -r nm w h dpr kind <<<"$cell"
  shoot "$kind" "$w" "$h" "$dpr" "$theme"
  ax eval "location.assign('/')" >/dev/null
  for _ in $(seq 30); do ax eval "!!document.querySelector('[aria-label^=\"Open Main, claude\"]')" | grep -q true && break; sleep 1; done
  ax eval "document.querySelector('[aria-label^=\"Open Main, claude\"]').click()" >/dev/null; sleep 5
  ax eval "document.querySelector('[aria-label=\"Chat view\"]')?.click()" >/dev/null; sleep 5
  name="chat-$nm-$theme"
  ax screenshot "$out/$name.png" >/dev/null
  read_back=$(ax eval "$READ" | head -1 | sed 's/^result: //; s/^"//; s/"$//; s/\\//g')
  node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" >"$out/$name.check.txt" 2>&1
  echo "$name: $read_back" | tee -a "$out/lines.log"
  ok=1
  case "$read_back" in *'"chat":true'*'"terminal":true'*'"copy":true'*) ;; *) ok=0 ;; esac
  # Below 170 dp the card has room for attach, mic and Send only, so the chip steps aside.
  if [ "$w" -ge 170 ]; then case "$read_back" in *'"chip":"Model Opus 5.5, effort High"'*) ;; *) ok=0 ;; esac; fi
  [ "$kind" = desktop ] && case "$read_back" in *'"panel":true'*) ;; *) ok=0 ;; esac
  [ "$ok" = 1 ] || misses=$((misses + 1))
done; done
cat >"$out/steps.json" <<JSON
{
  "target": { "version": "$(node -p "require('./package.json').version")" },
  "start": "the installed PWA (standalone --app window) paired to a private lab host over a fake Herdr with a seeded Claude conversation",
  "steps": ["pair the PWA through the lab hook", "open the Claude agent and switch it to Chat", "read the header switch, the model chip, Copy under a reply and, on desktop, the right panel at phone widths 360, 390, 445 and 270 (font 1.0 and 2.0) and desktop widths 1280 and 1440, dark and light"],
  "result": "every cell shows the Chat | Terminal switch in the header, the Opus 5.5 High model chip, Copy under replies and no pane count in the header, and the desktop cells show the right panel; $misses cells missed"
}
JSON
echo "standalone=$standalone paired=$paired misses=$misses"
[ "$standalone" != "${standalone%true*}" ] && [ "$misses" -eq 0 ]
