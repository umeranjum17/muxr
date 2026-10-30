#!/usr/bin/env bash
# Which harnesses muxr's chat is offered to, in the installed PWA
# (chat-harnesses.md): the chat fake lab (real relay, host and E2EE over a fake
# Herdr holding one agent of every kind), the lab web export on its own port, a
# standalone --app Chromium paired through window.__MUXR_LAB_PAIR__, then, for
# each harness in CHAT_HARNESSES (codex opencode by default) at phone 390 and
# desktop 1280 dp, dark and light: the agent opened in the app, the header's
# Chat control read back by its label, the chat view pressed, the agent held
# working with two screen lines and then blocked on a three-choice question.
# Chat slice 2's three facets (chat-working.md) are each tried on the harness and
# recorded per harness: the Running strip, the helper's reply card, the in-chat
# answer. A harness the app offers no chat to shows the terminal only, and its
# Answer buttons are the terminal's own chips, so one chip is tapped and the
# pane's input read back to see whether the answer still reaches the agent.
#
# A check judges every cited capture against the whole claim, so the cited
# folder holds only the frames this run's claim is about (CHAT_HARNESS_CITE);
# the whole width/theme matrix and the logs stay in the matrix folder beside it.
#
# Exit 0 when every harness matched the gate this lab asserts: the header keeps
# its Chat control labelled for Claude and Pi, pressing it draws no chat (no
# composer model chip, no Running strip, no helper card, no in-chat answer), the
# view chooser says chat reads Claude and Pi sessions only, and a terminal Answer
# chip that appears still types its number. Exit 1 when the app offers more or
# less than that, so a harness that gains a chat turns this red.
#   scripts/diagnostics/application/withPrivateXvfb.sh bash <this> <web export dir> <out dir>
# The export must carry the lab hook (EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export).
set -u
wt=$PWD
web=$1; out=$2
mx="${out%/}-matrix"; mkdir -p "$out" "$mx"
root=$(mktemp -d "${MUXR_LAB_ROOT:-$HOME/.cache/fms}/mxch.XXXXXX")
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
CHAT_LAB_PANES=5 CHAT_LAB_HELPER=1 node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs)" >"$root/lab.log" 2>&1 <"$root/lab.in" &
LAB_PID=$!
exec 3>"$root/lab.in"
lab() { echo "$*" >&3; sleep 1; }
for _ in $(seq 120); do grep -q 'lab ready' "$root/lab.log" && break; sleep 1; done
grep -q 'lab ready' "$root/lab.log" || { echo "the lab never came ready"; tail "$root/lab.log"; exit 1; }
kill -USR1 "$LAB_PID"
for _ in $(seq 30); do grep -q '^browser link:' "$root/lab.log" && break; sleep 1; done
link=$(sed -n 's/^browser link: //p' "$root/lab.log" | head -1)
[ -n "$link" ] || { echo "the lab never minted a browser link"; tail "$root/lab.log"; exit 1; }
MUXR_WEB_EXPORT_DIR="$web" MUXR_WEB_PORT=$WEB_PORT node scripts/diagnostics/application/serveWebExport.mjs >"$root/web.log" 2>&1 </dev/null &
SRV_PID=$!
chromium --user-data-dir="$root/profile" --remote-debugging-port=$CDP_PORT --hide-scrollbars --no-first-run --no-default-browser-check \
  --window-size=390,844 --app="http://127.0.0.1:$WEB_PORT/" >"$root/chromium.log" 2>&1 </dev/null &
CHR_PID=$!
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$CDP_PORT" CHROME_DEVTOOLS_AXI_SESSION="muxr-chat-harness-$$"
ax() { chrome-devtools-axi "$@" 2>&1; }
# A value written into steps.json: the reads are plain `key=value` text, never quoted.
jv() { printf '%s' "$1" | tr -d '"\\'; }
# A read answers in plain `key=value` pairs, so the shell and the log both see them.
read_eval() { ax eval "$1" | head -1 | sed 's/^result: //; s/^"//; s/"$//; s/\\"/"/g'; }
for _ in $(seq 60); do ax pages | grep -q "127.0.0.1:$WEB_PORT" && break; sleep 1; done
id=$(ax pages | grep "127.0.0.1:$WEB_PORT" | grep -o '^[^0-9]*[0-9]*' | grep -o '[0-9]*$' | head -1)
[ -n "$id" ] && ax selectpage "$id" >/dev/null
sleep 8
standalone=$(read_eval "matchMedia('(display-mode: standalone)').matches")
for _ in $(seq 60); do ax eval "typeof window.__MUXR_LAB_PAIR__" | grep -q function && break; sleep 1; done
paired=$(read_eval "(async () => typeof (await window.__MUXR_LAB_PAIR__('$link')).machineId)()")
echo "standalone: $standalone; paired: $paired"
ax eval "location.reload()" >/dev/null; sleep 10
# What the app says where the view is chosen. It is read before any agent opens: a
# session in the URL takes a later navigation back to itself, so a fresh boot is
# the only way to this screen.
ax eval "location.assign('/settings/session-view')" >/dev/null
for _ in $(seq 20); do ax eval "document.body.innerText.includes('Chat reads Claude and Pi sessions only')" | grep -q true && break; sleep 1; done
ax screenshot "$mx/session-view.png" >/dev/null
chooser=$(read_eval "document.body.innerText.includes('Chat reads Claude and Pi sessions only') && document.body.innerText.includes('Claude and Pi open as a chat; other agents open the terminal')")
echo "view-chooser=$chooser" | tee -a "$mx/lines.log"
case "$chooser" in *true*) ;; *) echo "the view chooser did not say chat reads Claude and Pi only" | tee -a "$mx/lines.log"; misses=$((misses+1));; esac
ax eval "location.assign('/')" >/dev/null; sleep 6
# name:width:height:dpr:kind; font F at W x H is a viewport of W/F x H/F (react-native-web pins fontScale to 1).
CELLS="${CHAT_HARNESS_CELLS:-390-1.0:390:844:3:mobile 1280:1280:800:1:desktop}"
shoot() { if [ "$1" = mobile ]; then ax emulate --viewport "$2x$3x$4,mobile,touch" --color-scheme "$5" >/dev/null; else ax emulate --viewport "$2x$3x$4" --color-scheme "$5" >/dev/null; fi; }
# The header's Chat control: the label the app gives it, and whether it reads as selected.
CHATCTL="(() => { const e = [...document.querySelectorAll('[aria-label]')].find((n) => /^Chat view/.test(n.getAttribute('aria-label'))); return e === undefined ? 'chat-control=none' : \`chat-control=\${e.getAttribute('aria-label')};chat-selected=\${e.getAttribute('aria-selected')}\`; })()"
# The chat's own furniture: the composer's model chip, the Running strip and a helper's card stand for "the chat is drawn".
CHATSHOWN="(() => { const l = [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')); return \`composer-chip=\${+l.some((t) => /^Model /.test(t))};running-strip=\${+l.some((t) => /^Working(,|\\.)/.test(t))};helper-card=\${+l.some((t) => /^Helper /.test(t))};answer-buttons=\${l.filter((t) => /^Answer /.test(t)).length}\`; })()"
QUESTION='────────────────\nRun rm -rf dist && pnpm build in /app/web? This deletes the existing dist folder, including the three files you edited by hand last week, and the build recreates it from source in about forty seconds.\n  1. Yes\n  2. Yes, and do not ask again for rm -rf dist commands in /app/web for the rest of this session\n  3. No, and tell Claude what to do differently'
misses=0
harness_rows=""
mkdir -p "$root/frames"
for harness in ${CHAT_HARNESSES:-codex opencode}; do
  lab "agent $harness"
  got=$(sed -n 's/^lab agent: //p' "$root/lab.log" | tail -1)
  case "$got" in "$harness"=*) ;; *) echo "$harness: the lab has no such agent (got '$got')" | tee -a "$mx/lines.log"; misses=$((misses+1)); continue;; esac
  control=; drawn=; tapped=not-tried; drawnAny=0
  for theme in ${CHAT_THEMES:-dark light}; do for cell in $CELLS; do
    IFS=: read -r nm w h dpr kind <<<"$cell"
    shoot "$kind" "$w" "$h" "$dpr" "$theme"
    lab "output "
    # A session in the URL owns it, so the way home is the header's own Back.
    ax eval "document.querySelector('[aria-label=\"Back\"]')?.click()" >/dev/null; sleep 2
    for _ in $(seq 30); do ax eval "[...document.querySelectorAll('[aria-label^=\"Open \"]')].some((e) => e.getAttribute('aria-label').includes(', $harness'))" | grep -q true && break; sleep 1; done
    ax eval "[...document.querySelectorAll('[aria-label^=\"Open \"]')].find((e) => e.getAttribute('aria-label').includes(', $harness')).click()" >/dev/null
    # The header draws the switch only once the pane's identity is known.
    for _ in $(seq 30); do ax eval "!!document.querySelector('[aria-label^=\"Chat view\"]')" | grep -q true && break; sleep 1; done
    name="$harness-$nm-$theme"
    control=$(read_eval "$CHATCTL")
    echo "$harness/$nm-$theme:$control" >>"$mx/lines.log"
    # The press a person would make: the control is drawn, so press it and see where it lands.
    ax eval "document.querySelector('[aria-label^=\"Chat view\"]')?.click()" >/dev/null; sleep 3
    drawn=$(read_eval "$CHATSHOWN")
    echo "$harness/$nm-$theme:$drawn" >>"$mx/lines.log"
    # The Running strip and the helper's card: hold the agent working with two lines, its conversation ending in a helper's reply.
    lab "output \$ pnpm test cart --run\n✓ cart.shipping.spec.ts (4 tests) 212ms"; lab "status working Fix empty cart shipping"
    sleep 3
    drawn="$drawn $(read_eval "$CHATSHOWN")"
    ax screenshot "$mx/$name-working.png" >/dev/null
    # The in-chat answer: hold it blocked on a question with three choices.
    lab "output $QUESTION"; lab "status blocked Fix empty cart shipping"
    sleep 4
    ask=$(read_eval "$CHATSHOWN")
    drawn="$drawn $ask"
    echo "$harness/$nm-$theme:$ask" >>"$mx/lines.log"
    ax screenshot "$mx/$name-ask.png" >/dev/null
    # Anything the chat would have drawn by now contradicts the gate, in every cell.
    case "$control$drawn" in
      *chat-control=none*) echo "$harness/$nm-$theme: the header drew no Chat control" | tee -a "$mx/lines.log"; misses=$((misses+1));;
      *composer-chip=1*|*running-strip=1*|*helper-card=1*) drawnAny=1; echo "$harness/$nm-$theme: the chat was drawn" | tee -a "$mx/lines.log"; misses=$((misses+1));;
    esac
    # A harness with no chat answers from the terminal's own chips: one tap, then the pane's own input.
    case "$ask" in *answer-buttons=0*) ;; *)
      ax screenshot "$root/frames/f1.png" >/dev/null
      ax eval "[...document.querySelectorAll('[aria-label^=\"Answer Yes, and\"]')][0]?.click()" >/dev/null
      ax screenshot "$root/frames/f2.png" >/dev/null
      lab "output "
      for n in 3 4 5 6; do sleep 0.5; ax screenshot "$root/frames/f$n.png" >/dev/null; done
      cp "$root/frames/f6.png" "$mx/$name-answered.png"
      ffmpeg -loglevel error -y -framerate 2 -i "$root/frames/f%d.png" -vf "scale=390:-2" -c:v libx264 -pix_fmt yuv420p "$mx/$name-answered.mp4" || misses=$((misses+1))
      input=$(sed -n 's/^lab input: //p' "$root/lab.log" | head -1)
      cp "$input" "$mx/$harness-pane-input.jsonl" 2>/dev/null
      grep -q '"source":"terminal.text".*"text":"2"' "$mx/$harness-pane-input.jsonl" 2>/dev/null && tapped=typed || tapped=none
      echo "$harness/$nm-$theme:terminal-answer-tap=$tapped" >>"$mx/lines.log"
      [ "$tapped" = typed ] || { echo "$harness/$nm-$theme: the tap did not reach the pane" | tee -a "$mx/lines.log"; misses=$((misses+1)); }
    ;; esac
    lab "output "; lab "status idle Fix empty cart shipping"
  done; done
  facet=$([ "$drawnAny" = 1 ] && echo drawn || echo absent)
  row="
    \"$harness\": { \"chatControl\": \"$(jv "$control")\", \"runningStrip\": \"$facet\", \"helperCard\": \"$facet\", \"inChatAnswer\": \"$facet\", \"terminalAnswerTap\": \"$(jv "$tapped")\" }"
  harness_rows="$harness_rows${harness_rows:+,}$row"
  # The frames this run's claim cites, out of the matrix folder. The working frame
  # stays in the matrix: a harness with no chat has no strip to shoot, so it shows
  # a terminal and nothing the claim is about.
  for name in "$harness-390-1.0-dark-ask.png" "$harness-390-1.0-dark-answered.mp4"; do
    cp "$mx/$name" "$out/" 2>/dev/null || { echo "missing citation $name" | tee -a "$mx/lines.log"; misses=$((misses+1)); }
  done
  echo "$harness: done" | tee -a "$mx/lines.log"
done
cat >"$mx/steps.json" <<JSON
{
  "target": { "version": "$(node -p "require('./package.json').version")" },
  "start": "the installed PWA (standalone --app window) paired to a private lab host over a fake Herdr holding one agent of every kind, its conversation ending in a helper's reply",
  "steps": ["pair the PWA through the lab hook", "open each harness's agent in the app and read the header's Chat control by its label", "press the Chat control and read whether the chat is drawn: the composer's model chip, the Running strip, a helper's card", "hold the agent working with two screen lines, then blocked on a three-choice question", "tap an Answer chip and read the pane's own input back", "read the Session view setting the app shows, at phone 390 and desktop 1280 dp, dark and light"],
  "harnesses": {$harness_rows
  },
  "viewChooserNamesClaudeAndPi": "$(jv "$chooser")",
  "result": "every harness kept its terminal-only view: the Chat control reads as available for Claude and Pi, pressing it drew no chat, the view chooser names Claude and Pi only, and the answer a blocked agent got came from the terminal's own chips; $misses cells contradicted that"
}
JSON
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$mx/steps.json" || misses=$((misses+1))
cp "$mx/steps.json" "$mx/lines.log" "$out" 2>/dev/null
echo "standalone=$standalone paired=$paired misses=$misses"
case "$standalone" in *true*) [ "$misses" -eq 0 ];; *) false;; esac
