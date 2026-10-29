#!/usr/bin/env bash
# Chat slice 2 in the installed PWA (chat-working.md: chat-running-strip,
# chat-helper-card, chat-ask-answer): the chat fake lab (real relay, host and
# E2EE over a fake Herdr, a seeded Claude log ending in a helper's reply), the
# lab web export on its own port, a standalone --app Chromium paired through
# window.__MUXR_LAB_PAIR__, then per cell (phone 360/390/445/270 at font 1.0,
# 270 at font 2.0, desktop 1280/1440; dark and light) the Claude agent in Chat
# in four states the lab holds through its stdin: working with its last two
# lines (the Running strip), the helper's reply card, blocked on a question
# with three choices (the in-chat answer, the longest question and choice the
# lab can hold), and stopped with no output (the strip gone). One cell taps a
# choice and reads back that the host's pane got that key.
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export).
set -u
wt=$PWD
web=$1; out=$2
mkdir -p "$out"
root=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache}/muxr-chat-work.XXXXXX")
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_PORT=$(free_port); CDP_PORT=$(free_port)
LAB_PID=; SRV_PID=; CHR_PID=
cleanup() {
  exec 3>&- 2>/dev/null
  for p in $CHR_PID $SRV_PID $LAB_PID; do kill "$p" 2>/dev/null; done
  for p in $CHR_PID $SRV_PID $LAB_PID; do for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; done
  rm -rf -- "$root"
}
trap cleanup EXIT
mkfifo "$root/lab.in"
CHAT_LAB_HELPER=1 node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs)" >"$root/lab.log" 2>&1 <"$root/lab.in" &
LAB_PID=$!
exec 3>"$root/lab.in"
lab() { echo "$*" >&3; sleep 1; }
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
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-chat-work-$$"
ax() { chrome-devtools-axi "$@" 2>&1; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
id=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$id" ] && ax selectpage "$id" >/dev/null
sleep 8
standalone=$(ax eval "matchMedia('(display-mode: standalone)').matches" | head -1)
for _ in $(seq 60); do ax eval "typeof window.__MUXR_LAB_PAIR__" | grep -q function && break; sleep 1; done
paired=$(ax eval "(async () => typeof (await window.__MUXR_LAB_PAIR__('$link')).machineId)()" | head -1)
echo "standalone: $standalone; paired: $paired"
ax eval "location.reload()" >/dev/null; sleep 10
# name:width:height:dpr:kind; font F at W x H is a viewport of W/F x H/F (react-native-web pins fontScale to 1).
CELLS="${CHAT_WORK_CELLS:-360-1.0:360:800:3:mobile 390-1.0:390:844:3:mobile 445-1.0:445:960:3:mobile 270-1.0:270:594:2:mobile 270-2.0:135:297:4:mobile 1280:1280:800:1:desktop 1440:1440:900:1:desktop}"
shoot() { if [ "$1" = mobile ]; then ax emulate --viewport "$2x$3x$4,mobile,touch" --color-scheme "$5" >/dev/null; else ax emulate --viewport "$2x$3x$4" --color-scheme "$5" >/dev/null; fi; }
labels() { ax eval "JSON.stringify([...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')))" | head -1; }
# Wait for a label matching a regex (or its absence with "!").
await_label() { for _ in $(seq 20); do l=$(labels); if [ "${1:0:1}" = '!' ]; then echo "$l" | grep -Eq "${1:1}" || return 0; else echo "$l" | grep -Eq "$1" && return 0; fi; sleep 1; done; return 1; }
QUESTION='────────────────\nRun rm -rf dist && pnpm build in /app/web? This deletes the existing dist folder, including the three files you edited by hand last week, and the build recreates it from source in about forty seconds.\n  1. Yes\n  2. Yes, and do not ask again for rm -rf dist commands in /app/web for the rest of this session\n  3. No, and tell Claude what to do differently'
misses=0
# A check judges every cited capture against the whole claim, so the cited folder holds only the frames this
# run's claim is about (CHAT_WORK_CITE); the whole width/theme matrix stays in the matrix folder beside it.
mx="${out%/}-matrix"; mkdir -p "$mx"
for theme in ${CHAT_WORK_THEMES:-dark light}; do for cell in $CELLS; do
  IFS=: read -r nm w h dpr kind <<<"$cell"
  shoot "$kind" "$w" "$h" "$dpr" "$theme"
  lab "output "
  ax eval "location.assign('/')" >/dev/null
  for _ in $(seq 30); do ax eval "!!document.querySelector('[aria-label^=\"Open \"][aria-label*=\", claude\"]')" | grep -q true && break; sleep 1; done
  ax eval "document.querySelector('[aria-label^=\"Open \"][aria-label*=\", claude\"]').click()" >/dev/null; sleep 5
  ax eval "document.querySelector('[aria-label=\"Chat view\"]')?.click()" >/dev/null; sleep 4
  ok=1
  # 1. The helper's reply is its own card.
  await_label '"Helper Audit cart shipping tests' || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  ax eval "[...document.querySelectorAll('[aria-label^=\"Helper \"]')].pop()?.scrollIntoView({block:'center'})" >/dev/null; sleep 1
  ax screenshot "$mx/helper-$nm-$theme.png" >/dev/null
  # 2. Working: the strip names the task and shows the pane's last two lines.
  lab "output \$ pnpm test cart --run\n✓ cart.shipping.spec.ts (4 tests) 212ms"; lab "status working Fix empty cart shipping"
  await_label '"Working, Fix empty cart shipping' || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  ax eval "document.body.innerText.includes('cart.shipping.spec.ts (4 tests)')" | grep -q true || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  ax screenshot "$mx/working-$nm-$theme.png" >/dev/null
  # 3. The strip changes as the pane's lines do.
  lab "output \$ pnpm test cart.total --run\n✕ expected 50, received 0 at cart.total.spec.ts:18"
  for _ in $(seq 10); do ax eval "document.body.innerText.includes('expected 50, received 0')" | grep -q true && break; sleep 1; done
  ax eval "document.body.innerText.includes('expected 50, received 0')" | grep -q true || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  # 4. Blocked on a question: the choices are buttons in the chat.
  lab "output $QUESTION"; lab "status blocked Fix empty cart shipping"
  await_label 'Answer Yes[^,A-Za-z]' || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  ax screenshot "$mx/ask-$nm-$theme.png" >/dev/null
  # 5. Stopped with no output: the strip and the question are gone.
  lab "output "; lab "status idle Fix empty cart shipping"
  await_label '!"Working,|"Answer ' || { ok=0; echo "$nm-$theme missed at line $LINENO" | tee -a "$out/lines.log"; }
  ax screenshot "$mx/stopped-$nm-$theme.png" >/dev/null
  echo "$nm-$theme: ok=$ok" | tee -a "$out/lines.log"
  for shot in helper working ask stopped; do node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$mx/$shot-$nm-$theme.png" "$shot-$nm-$theme" >"$mx/$shot-$nm-$theme.check.txt" 2>&1; done
  [ "$ok" = 1 ] || misses=$((misses + 1))
done; done
# One answer, end to end: tap a choice in the chat and the host's pane receives its number.
shoot mobile 390 844 3 dark; sleep 3
lab "output $QUESTION"; lab "status blocked Fix empty cart shipping"
await_label 'Answer Yes[^,A-Za-z]' || misses=$((misses + 1))
ax eval "[...document.querySelectorAll('[aria-label^=\"Answer Yes, and\"]')][0]?.click()" >/dev/null; sleep 1
ax screenshot "$mx/answered-390-dark.png" >/dev/null
input=$(sed -n 's/^lab input: //p' "$root/lab.log" | head -1)
cp "$input" "$out/pane-input.jsonl" 2>/dev/null
# Choice 2's number reached the pane through the terminal's own channel.
answered=none
grep -q '"source":"terminal.text".*"text":"2"' "$out/pane-input.jsonl" 2>/dev/null && answered=typed
echo "answered: $answered" | tee -a "$out/lines.log"
[ "$answered" = typed ] || misses=$((misses + 1))
for name in ${CHAT_WORK_CITE:-}; do cp "$mx/$name.png" "$out/"; cp "$mx/$name.check.txt" "$out/" 2>/dev/null || true; done
cat >"$out/steps.json" <<JSON
{
  "target": { "version": "$(node -p "require('./package.json').version")" },
  "start": "the installed PWA (standalone --app window) paired to a private lab host over a fake Herdr with a seeded Claude conversation that ends in a helper's reply",
  "steps": ["pair the PWA through the lab hook", "open the Claude agent in Chat and read the helper's reply card", "hold the agent working with two screen lines and read the Running strip, then change the lines", "hold it blocked on a question with three choices and read the answer buttons, then tap one", "stop the agent with no output and read that the strip and the question are gone, at phone widths 360, 390, 445 and 270 (font 1.0 and 2.0) and desktop 1280 and 1440, dark and light"],
  "result": "every cell shows the helper card, the Running strip with the pane's lines, the question's answer buttons and, once stopped, neither; $misses cells missed"
}
JSON
echo "standalone=$standalone paired=$paired misses=$misses"
[ "$standalone" != "${standalone%true*}" ] && [ "$misses" -eq 0 ]
