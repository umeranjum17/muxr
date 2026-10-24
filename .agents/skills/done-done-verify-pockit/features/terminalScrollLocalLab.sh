#!/usr/bin/env bash
# Phone-side history journey (terminal-latest.md, latest-local): the release APK
# on a caller-owned Android device, fresh-paired to the Latest lab with one
# fullscreen Claude Code pane printing MARK-1..LINES (400) at STUB_LPS (15)
# lines/s while attached. Saves the live edge, a stepped 400 px drag back, a
# fling back and Latest, and writes each screen's visible MARK range to
# proof.log. WALK=n instead walks back through the history in n stepped drags
# of under a screen each, at 411 dp, and logs every break in the MARK numbers a screen
# shows (`gap MARK-a -> MARK-b`), the hole check, recorded to walk.mp4.
# DENSITY sets the width first: 640 on a 1080 px screen is the 270 dp reference
# phone, where the grid is taller than its box and a drag pans it before the
# history moves.
# Run from the repo root:
# bash <this> <apk> <evidence-dir>, with MUXR_LAB_SERIAL and a provisioned Herdr
# lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION, HERDR_LAB_PREPROVISIONED=1).
# Needs adb and tesseract.
set -u
APK=$1; E=$2; SER=${MUXR_LAB_SERIAL:?}; REPO=$PWD
LINES=${LINES:-400}; LPS=${STUB_LPS:-15}; WALK=${WALK:-0}; DENSITY=${DENSITY:-}
D=$(mktemp -d); trap 'rm -rf -- "$D"' EXIT; mkfifo "$D/in"
a() { adb -s "$SER" "$@" </dev/null; }
t0=$(date +%s%3N); log() { echo "$(( $(date +%s%3N) - t0 )) $*" | tee -a "$E/proof.log"; }
marks() { tesseract "$1" - --psm 6 2>/dev/null | grep -o 'MARK-[0-9]*'; }
# A screen's MARK range, its row count and every break in its numbers.
shot() {
    a exec-out screencap -p > "$E/$1.png"; local m; m=$(marks "$E/$1.png")
    log "$1 $(echo "$m" | sed -n '1p;$p' | tr '\n' ' ')rows=$(echo "$m" | grep -c .)$(echo "$m" | tr -dc '0-9\n' | awk 'NR>1 && $1!=p+1 {printf " gap MARK-%d -> MARK-%d", p, $1} {p=$1}')"
}
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
[ -n "$DENSITY" ] && { a shell wm density "$DENSITY"; trap 'a shell wm density reset; rm -rf -- "$D"' EXIT; sleep 10; }
a uninstall com.trymuxr.app >/dev/null 2>&1; a install "$APK" | tail -1
a shell pm grant com.trymuxr.app android.permission.POST_NOTIFICATIONS 2>/dev/null
log "installed $(basename "$APK") on $SER"
SERIAL=$SER EVIDENCE=$D KINDS=claude LINES=$LINES STUB_LPS=$LPS \
    node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/terminalLatestLab.mjs)" < "$D/in" > "$D/lab.log" 2>&1 &
LAB=$!; exec 3> "$D/in"
# Closing the lab's stdin quits it: it stops its panes, host, relay and fixture.
quit() { exec 3>&-; wait $LAB; }
# A step that never came: keep the screen and the lab's log beside the proof.
fail() { log "$1"; a exec-out screencap -p > "$E/failed.png"; quit; cp "$D/lab.log" "$E/lab.log"; exit 1; }
timeout 180 bash -c "until grep -q -E 'ready:|exit=' '$D/lab.log'; do sleep 2; done"; log "lab $(grep -o 'ready: claude' "$D/lab.log")"
echo pair >&3; for i in $(seq 1 12); do sleep 5; R=$(find_node '^Pair$'); [ -n "$R" ] && break; done
[ -n "$R" ] || fail "no Pair"
a shell input tap $R; sleep 10
for i in 1 2 3 4 5 6; do R=$(find_node 'Umer claude. '); [ -n "$R" ] && break; sleep 8; done
[ -n "$R" ] || fail "no agent card"
a shell input tap $R; sleep 6; log "opened the Claude Code pane"
echo "stream claude" >&3; log "stream: $LINES MARK lines at $LPS/s"; sleep $(( LINES / LPS + 7 ))
shot live-edge
if [ "$WALK" -gt 0 ]; then
    # Each drag moves the view less than a screen, so consecutive screens share
    # rows and a hole shows up inside one of them. The walk is recorded to walk.mp4.
    adb -s "$SER" shell screenrecord --time-limit 180 /sdcard/walk.mp4 </dev/null & REC=$!
    for i in $(seq 1 "$WALK"); do
        a shell 'input motionevent DOWN 300 600; y=600; while [ $y -lt 1400 ]; do y=$((y+20)); input motionevent MOVE 300 $y; done; input motionevent UP 300 1400'
        sleep 1; shot "walk-$(printf %02d "$i")"
    done
    a shell pkill -INT screenrecord; wait $REC; a pull /sdcard/walk.mp4 "$E/walk.mp4" >/dev/null
else
log "slow drag back: finger down 400 px in 20 px steps"
a shell 'input motionevent DOWN 300 700; y=700; while [ $y -lt 1100 ]; do y=$((y+20)); input motionevent MOVE 300 $y; done; input motionevent UP 300 1100'
log "finger up"; sleep 2; shot after-drag
log "fling back"; a shell input swipe 300 600 300 1600 90; log "finger up"; sleep 3; shot after-fling
fi
R=$(find_node 'Jump to latest'); log "latest pill: ${R:+shown}"; [ -n "$R" ] && a shell input tap $R; sleep 3
shot after-latest
log "pill after latest: $(find_node 'Jump to latest' | grep -c .)"
quit; log "lab $(tail -1 "$D/lab.log")"
cat > "$E/steps.json" <<JSON
{"target": {"version": "muxr Android release $(node -p "require('$REPO/package.json').version")+$(git rev-parse --short HEAD)"},
 "start": "Fresh install, paired to a private lab host with one fullscreen Claude Code pane; the pane prints MARK-1..$LINES at $LPS lines/s while the phone is attached",
 "steps": ["Open the Claude Code pane from Home", "Wait for the output to finish (live edge)", $([ "$WALK" -gt 0 ] && echo "\"Walk back through the history in $WALK stepped 800 px drags\"" || echo '"Drag back slowly 400 px", "Fling back"'), "Tap Latest"],
 "result": "$([ "$WALK" -gt 0 ] && echo "Every walked screen shows consecutive MARK rows (no gap line in proof.log), and Latest returns to the newest output (MARK-$LINES) with the pill gone" || echo "The drag moves the view about as far as the finger, the fling keeps going back through consecutive rows with Latest shown, and Latest returns to the newest output (MARK-$LINES) with the pill gone")"}
JSON
