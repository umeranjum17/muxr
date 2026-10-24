#!/usr/bin/env bash
# Home's version line and Settings > About in the installed PWA
# (home-version-line.md): a loopback fake-Herdr stack, the lab web export served
# on its own port, a standalone --app Chromium paired through
# window.__MUXR_LAB_PAIR__, then per cell (phone 360/390/445/270 at font 1.0,
# 270/393 at font 2.0, desktop 1280/1440; dark and light) the foot of Home
# scrolled to its end and the Settings Version row, each read back as text and
# run through pwa-check. Exit 1 when any cell does not read `App <version>`.
# From the repo root, on a private display:
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export).
set -u
wt=$PWD
web=$1; out=$2
mkdir -p "$out"
root=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache}/muxr-version-pwa.XXXXXX")
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_PORT=$(free_port); CDP_PORT=$(free_port)
LAB_PID=; SRV_PID=; CHR_PID=
cleanup() {
  for p in $CHR_PID $SRV_PID $LAB_PID; do kill "$p" 2>/dev/null; done
  for p in $CHR_PID $SRV_PID $LAB_PID; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; done
  rm -rf -- "$root"
}
trap cleanup EXIT
node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/browserPairLab.mjs)" >"$root/lab.log" 2>&1 </dev/null &
LAB_PID=$!
for _ in $(seq 120); do grep -q '^browser link:' "$root/lab.log" && break; sleep 1; done
link=$(sed -n 's/^browser link: //p' "$root/lab.log" | head -1)
[ -n "$link" ] || { echo "the lab never minted a browser link"; tail "$root/lab.log"; exit 1; }
MUXR_WEB_EXPORT_DIR="$web" MUXR_WEB_PORT=$WEB_PORT node scripts/diagnostics/application/serveWebExport.mjs >"$root/web.log" 2>&1 </dev/null &
SRV_PID=$!
chromium --user-data-dir="$root/profile" --remote-debugging-port=$CDP_PORT --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size=393,844 --app="http://127.0.0.1:$WEB_PORT/" >"$root/chromium.log" 2>&1 </dev/null &
CHR_PID=$!
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-version-pwa-$$"
ax() { chrome-devtools-axi "$@" 2>&1; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
id=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$id" ] && ax selectpage "$id" >/dev/null
sleep 8
standalone=$(ax eval "matchMedia('(display-mode: standalone)').matches" | head -1)
paired=$(ax eval "(async () => typeof (await window.__MUXR_LAB_PAIR__('$link')).machineId)()" | head -1)
echo "standalone: $standalone; paired: $paired"
ax eval "location.reload()" >/dev/null; sleep 10
version=$(node -p "require('./package.json').version")
# name:width:height:dpr:kind; font F at W x H is a viewport of W/F x H/F (react-native-web pins fontScale to 1).
CELLS="360-1.0:360:800:3:mobile 390-1.0:390:844:3:mobile 445-1.0:445:960:3:mobile 270-1.0:270:594:2:mobile 270-2.0:135:297:4:mobile 393-2.0:196:432:4:mobile 1280:1280:800:1:desktop 1440:1440:900:1:desktop"
shoot() { if [ "$1" = mobile ]; then ax emulate --viewport "$2x$3x$4,mobile,touch" --color-scheme "$5" >/dev/null; else ax emulate --viewport "$2x$3x$4" --color-scheme "$5" >/dev/null; fi; }
misses=0
for theme in dark light; do for cell in $CELLS; do
  IFS=: read -r nm w h dpr kind <<<"$cell"
  shoot "$kind" "$w" "$h" "$dpr" "$theme"
  ax eval "location.assign('/')" >/dev/null
  for _ in $(seq 30); do t=$(ax eval "document.body.innerText.length" | head -1 | tr -dc 0-9); [ "${t:-0}" -gt 50 ] && break; sleep 1; done
  shoot "$kind" "$w" "$h" "$dpr" "$theme"; sleep 4
  ax eval "document.querySelectorAll('*').forEach((e) => { if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; })" >/dev/null; sleep 2
  name="home-foot-$nm-$theme"
  ax screenshot "$out/$name.png" >/dev/null
  line=$(ax eval "[...document.querySelectorAll('[role=button]')].map((e) => e.innerText).find((t) => /^App \\d/.test(t)) ?? 'no version line'" | head -1)
  node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" >"$out/$name.check.txt" 2>&1
  echo "$name: $line" | tee -a "$out/lines.log"
  case "$line" in *"App $version"*) ;; *) misses=$((misses + 1)) ;; esac
  ax eval "location.assign('/settings')" >/dev/null
  for _ in $(seq 30); do t=$(ax eval "document.body.innerText.includes('Version') ? 1 : 0" | head -1 | tr -dc 0-9); [ "${t:-0}" = 1 ] && break; sleep 1; done
  shoot "$kind" "$w" "$h" "$dpr" "$theme"; sleep 3
  ax eval "(() => { const v = [...document.querySelectorAll('div')].find((e) => e.innerText === 'Version'); v?.scrollIntoView({ block: 'center' }); })()" >/dev/null; sleep 2
  name="settings-version-$nm-$theme"
  ax screenshot "$out/$name.png" >/dev/null
  row=$(ax eval "(() => { const v = [...document.querySelectorAll('div')].find((e) => e.innerText === 'Version'); return v?.parentElement?.innerText.replace(/\\n/g, ' / ') ?? 'no Version row'; })()" | head -1)
  node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" >"$out/$name.check.txt" 2>&1
  echo "$name: $row" | tee -a "$out/lines.log"
  case "$row" in *"App $version"*) ;; *) misses=$((misses + 1)) ;; esac
done; done
read_as=$(head -1 "$out/lines.log" | sed 's/^[^:]*: //; s/^result: //; s/"//g; s/\\//g')
cat >"$out/steps.json" <<EOF
{
  "target": { "version": "$version" },
  "start": "the installed PWA (standalone --app window) paired to a private lab host over a fake Herdr; the web export names its own build",
  "steps": ["pair the PWA through the lab hook", "read the foot of Home scrolled to its end and Settings > About > Version at phone widths 360, 390, 445 and 270 (font 1.0), 270 and 393 at font 2.0, and desktop widths 1280 and 1440, dark and light"],
  "result": "Home's foot and the Settings Version row read the app and host versions ($read_as) in every cell; $misses cells missed"
}
EOF
echo "standalone=$standalone paired=$paired misses=$misses"
[ "$standalone" != "${standalone%true*}" ] && [ "$misses" -eq 0 ]
