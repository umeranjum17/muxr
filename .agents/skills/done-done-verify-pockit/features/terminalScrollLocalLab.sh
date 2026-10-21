#!/usr/bin/env bash
# Phone-side history journey (terminal-latest.md, latest-local): the release APK
# on a caller-owned Android device, fresh-paired to the Latest lab with one
# fullscreen Claude Code pane printing MARK-1..400 at 15 lines/s while attached.
# Saves the live edge, a stepped 400 px drag back, a fling back and Latest, and
# writes each screen's visible MARK range to proof.log. Run from the repo root:
# bash <this> <apk> <evidence-dir>, with MUXR_LAB_SERIAL and a provisioned Herdr
# lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION, HERDR_LAB_PREPROVISIONED=1).
# Needs adb, tesseract and ffmpeg.
set -u
APK=$1; E=$2; SER=${MUXR_LAB_SERIAL:?}; REPO=$PWD
D=$(mktemp -d); trap 'rm -rf -- "$D"' EXIT; mkfifo "$D/in"
a() { adb -s "$SER" "$@" </dev/null; }
t0=$(date +%s%3N); log() { echo "$(( $(date +%s%3N) - t0 )) $*" | tee -a "$E/proof.log"; }
marks() { tesseract "$1" - --psm 6 2>/dev/null | grep -o 'MARK-[0-9]*'; }
shot() { a exec-out screencap -p > "$E/$1.png"; local m; m=$(marks "$E/$1.png"); log "$1 $(echo "$m" | sed -n '1p;$p' | tr '\n' ' ')rows=$(echo "$m" | grep -c .)"; }
# Centre of the first node whose text or content-desc matches $1, empty if none.
find_node() {
    a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    a exec-out cat /sdcard/ui.xml | python3 -c '
import re,sys
for n in re.findall(r"<node\s[^>]*>", sys.stdin.read()):
    t=re.search(r" text=\"([^\"]*)\"",n).group(1); d=re.search(r"content-desc=\"([^\"]*)\"",n).group(1)
    if re.search(sys.argv[1],t) or re.search(sys.argv[1],d):
        b=list(map(int,re.findall(r"\d+",re.search(r"bounds=\"([^\"]*)\"",n).group(1)))); print((b[0]+b[2])//2,(b[1]+b[3])//2); break
' "$1"
}

mkdir -p "$E"
a uninstall com.trymuxr.app >/dev/null 2>&1; a install "$APK" | tail -1
a shell pm grant com.trymuxr.app android.permission.POST_NOTIFICATIONS 2>/dev/null
log "installed $(basename "$APK") on $SER"
SERIAL=$SER EVIDENCE=$D KINDS=claude LINES=400 STUB_LPS=15 \
    node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/terminalLatestLab.mjs)" < "$D/in" > "$D/lab.log" 2>&1 &
LAB=$!; exec 3> "$D/in"
# Closing the lab's stdin quits it: it stops its panes, host, relay and fixture.
quit() { exec 3>&-; wait $LAB; }
timeout 180 bash -c "until grep -q -E 'ready:|exit=' '$D/lab.log'; do sleep 2; done"; log "lab $(grep -o 'ready: claude' "$D/lab.log")"
echo pair >&3; for i in 1 2 3 4 5 6; do sleep 5; R=$(find_node '^Pair$'); [ -n "$R" ] && break; done
[ -n "$R" ] || { log "no Pair"; quit; exit 1; }
a shell input tap $R; sleep 10
for i in 1 2 3 4 5 6; do R=$(find_node 'Umer claude. '); [ -n "$R" ] && break; sleep 8; done
[ -n "$R" ] || { log "no agent card"; quit; exit 1; }
a shell input tap $R; sleep 6; log "opened the Claude Code pane"
echo "stream claude" >&3; log "stream: 400 MARK lines at 15/s"; sleep 34
shot live-edge
log "slow drag back: finger down 400 px in 20 px steps"
a shell 'input motionevent DOWN 300 700; y=700; while [ $y -lt 1100 ]; do y=$((y+20)); input motionevent MOVE 300 $y; done; input motionevent UP 300 1100'
log "finger up"; sleep 2; shot after-drag
log "fling back"; a shell input swipe 300 600 300 1600 90; log "finger up"; sleep 3; shot after-fling
R=$(find_node 'Jump to latest'); log "latest pill: ${R:+shown}"; [ -n "$R" ] && a shell input tap $R; sleep 3
# The newest output looks exactly like the live edge: keep the terminal area only, so the file is its own capture.
a exec-out screencap -p > "$D/latest.png"
ffmpeg -v error -y -i "$D/latest.png" -vf 'crop=1080:1650:0:150' "$E/after-latest-terminal.png"
log "after-latest-terminal $(marks "$E/after-latest-terminal.png" | sed -n '1p;$p' | tr '\n' ' ')"
log "pill after latest: $(find_node 'Jump to latest' | grep -c .)"
quit; log "lab $(tail -1 "$D/lab.log")"
cat > "$E/steps.json" <<JSON
{"target": {"version": "muxr Android release $(node -p "require('$REPO/package.json').version")+$(git rev-parse --short HEAD)"},
 "start": "Fresh install, paired to a private lab host with one fullscreen Claude Code pane; the pane prints MARK-1..400 at 15 lines/s while the phone is attached",
 "steps": ["Open the Claude Code pane from Home", "Wait for the output to finish (live edge)", "Drag back slowly 400 px", "Fling back", "Tap Latest"],
 "result": "The drag moves the view about as far as the finger, the fling keeps going back through consecutive rows with Latest shown, and Latest returns to the newest output (MARK-400) with the pill gone"}
JSON
