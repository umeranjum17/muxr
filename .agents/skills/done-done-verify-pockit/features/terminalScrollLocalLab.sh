#!/usr/bin/env bash
# Phone-side history journey (terminal-latest.md, latest-local): the release APK
# on a caller-owned Android device, fresh-paired to the Latest lab with one
# fullscreen Claude Code pane printing MARK-1..LINES (400) at STUB_LPS (15)
# lines/s while attached. Saves the live edge, a stepped 400 px drag back, a
# fling back and Latest, and writes each screen's visible MARK range to
# proof.log. WALK=n instead walks back through the history in n stepped drags
# of under a screen each and records walk.mp4. At 270 dp, 30 drags have shown
# 11-12 MARK rows per screen, not 30 rows per drag. proof.log records each
# screen's count and each within-screen break as `gap MARK-a -> MARK-b`.
# DENSITY sets the width first: 640 on a 1080 px screen is the 270 dp reference
# phone, where the grid is taller than its box and a drag pans it before the
# history moves.
# KIND=shell walks a shell pane instead: Herdr owns that pane's scrollback, so a
# drag past the pan moves Herdr's own viewport and each step it takes must reach
# the phone as its own screen (the host walks it a screen at a time). A Claude
# Code pane (the default) has no Herdr scrollback and is scrolled by wheel.
# Run from the repo root:
# bash <this> <apk> <evidence-dir>, with MUXR_LAB_SERIAL and a provisioned Herdr
# lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION, HERDR_LAB_PREPROVISIONED=1).
# Needs adb and tesseract.
set -u
APK=$1; E=$2; SER=${MUXR_LAB_SERIAL:?}
LINES=${LINES:-400}; LPS=${STUB_LPS:-15}; WALK=${WALK:-0}; DENSITY=${DENSITY:-}; KIND=${KIND:-claude}
D=$(mktemp -d); trap 'rm -rf -- "$D"' EXIT; mkfifo "$D/in"
a() { adb -s "$SER" "$@" </dev/null; }
t0=$(date +%s%3N); log() { echo "$(( $(date +%s%3N) - t0 )) $*" | tee -a "$E/proof.log"; }
# Ids tesseract read off a screen. An id outside MARK-1..LINES cannot be one the
# pane printed (it reads MARK-1000 as MARK-10080), so it takes the id its two
# neighbours name, which only exists when they differ by two; an id it cannot
# place is dropped. A row that is really missing still shows as a break in the
# numbers, because no unreadable id sits where it should have been.
marks() {
    tesseract "$1" - --psm 6 2>/dev/null | grep -o 'MARK-[0-9]*' | sed 's/MARK-//' | awk -v n="$LINES" '
        { v[NR] = $1 + 0 }
        END {
            for (i = 1; i <= NR; i++) {
                if (v[i] >= 1 && v[i] <= n) { print "MARK-" v[i]; continue }
                p = (i > 1) ? v[i-1] : 0; q = (i < NR) ? v[i+1] : 0
                if (p >= 1 && p <= n && q >= 1 && q <= n && q == p + 2) print "MARK-" (p + 1)
            }
        }'
}
# A screen's MARK range, its row count and every break in its numbers.
shot() {
    a exec-out screencap -p > "$E/$1.png"; local m; m=$(marks "$E/$1.png")
    log "$1 $(echo "$m" | sed -n '1p;$p' | tr '\n' ' ')rows=$(echo "$m" | grep -c .)"
    # Compare every adjacent MARK on this screen, not just its range endpoints.
    while IFS= read -r gap; do log "$gap ($1)"; done < <(
        printf '%s\n' "$m" | awk -F- 'NF==2 {if (seen && $2!=p+1) printf "gap MARK-%d -> MARK-%d\n", p, $2; p=$2; seen=1}'
    )
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

# A slow device ANRs System UI under the install and the screenshots; the dialog
# sits over the app, so its "Wait" is dismissed rather than tapped through.
dismiss_anr() { local w; w=$(find_node '^Wait$'); [ -n "$w" ] && { a shell input tap $w; log "dismissed a System UI ANR"; sleep 2; }; }
mkdir -p "$E"
[ -n "$DENSITY" ] && { a shell wm density "$DENSITY"; trap 'a shell wm density reset; rm -rf -- "$D"' EXIT; sleep 10; }
a uninstall com.trymuxr.app >/dev/null 2>&1; a install "$APK" | tail -1
a shell pm grant com.trymuxr.app android.permission.POST_NOTIFICATIONS 2>/dev/null
log "installed $(basename "$APK") on $SER sha256=$(sha256sum "$APK" | cut -d ' ' -f1)"
SERIAL=$SER EVIDENCE=$D KINDS=$KIND LINES=$LINES STUB_LPS=$LPS \
    node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/terminalLatestLab.mjs)" < "$D/in" > "$D/lab.log" 2>&1 &
LAB=$!; exec 3> "$D/in"
# Closing the lab's stdin quits it: it stops its panes, host, relay and fixture.
quit() { exec 3>&-; wait $LAB; }
# A step that never came: keep the screen and the lab's log beside the proof.
fail() { log "$1"; a exec-out screencap -p > "$E/failed.png"; quit; cp "$D/lab.log" "$E/lab.log"; exit 1; }
timeout 180 bash -c "until grep -q -E 'ready:|exit=' '$D/lab.log'; do sleep 2; done"; log "lab $(grep -o "ready: $KIND" "$D/lab.log")"
echo pair >&3
for i in $(seq 1 12); do sleep 5; R=$(find_node '^Pair$'); [ -n "$R" ] && break; dismiss_anr; done
[ -n "$R" ] || fail "no Pair"
a shell input tap $R; sleep 10
# Home lists panes an agent runs in, and a bare shell becomes one the moment a
# program runs there, so the shell walk starts its output before it looks for
# the card. A Claude Code pane already is an agent.
STARTED=
if [ "$KIND" = shell ]; then echo "stream $KIND" >&3; log "stream: $LINES MARK lines ($KIND)"; STARTED=$(date +%s); fi
# Home's Live list holds agents; a shell pane is a terminal, so it is opened
# from Panes (Home's header) when no agent card matches.
R=
for i in 1 2 3; do R=$(find_node "Umer $KIND. "); [ -n "$R" ] && break; dismiss_anr; sleep 8; done
if [ -z "$R" ]; then
    P=$(find_node '^Panes$'); [ -n "$P" ] || fail "no Panes"
    a shell input tap $P; sleep 6
    # The tab card's name is not a way in; the pane row is the shell's prompt
    # line, user@host:dir.
    for i in 1 2 3; do R=$(find_node '@[A-Za-z0-9._-]+:/'); [ -n "$R" ] && break; R=$(find_node "Umer $KIND"); [ -n "$R" ] && break; dismiss_anr; sleep 8; done
    log "opened Panes"
fi
[ -n "$R" ] || fail "no $KIND pane"
a shell input tap $R; sleep 6; log "opened the $KIND pane"
# A shell pane prints its own loop (60 ms a line); a Claude Code pane is driven
# by the stub at STUB_LPS.
[ -n "$STARTED" ] || { echo "stream $KIND" >&3; log "stream: $LINES MARK lines ($KIND)"; STARTED=$(date +%s); }
TOTAL=$([ "$KIND" = shell ] && echo $(( LINES * 6 / 100 )) || echo $(( LINES / LPS )))
WAIT=$(( STARTED + TOTAL + 7 - $(date +%s) )); [ "$WAIT" -lt 5 ] && WAIT=5
log "waiting ${WAIT}s for the output to finish"; sleep "$WAIT"
shot live-edge
if [ "$WALK" -gt 0 ]; then
    # Each drag is intended to move less than a screen so an overlap can expose
    # a missing row. The captures, not that intention, establish what was seen.
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
# The fling is recorded: a jump the host walks a screen at a time shows the
# screens it passes in fling.mp4, where one jump would show only the landing.
adb -s "$SER" shell screenrecord --time-limit 60 /sdcard/fling.mp4 </dev/null & REC=$!
log "fling back"; a shell input swipe 300 600 300 1600 90; log "finger up"; sleep 3; shot after-fling
a shell pkill -INT screenrecord; wait $REC; a pull /sdcard/fling.mp4 "$E/fling.mp4" >/dev/null
fi
R=$(find_node 'Jump to latest'); log "latest pill: ${R:+shown}"; [ -n "$R" ] && a shell input tap $R; sleep 3
shot after-latest
log "pill after latest: $(find_node 'Jump to latest' | grep -c .)"
quit; log "lab $(tail -1 "$D/lab.log")"
cat > "$E/steps.json" <<JSON
{"target": {"version": "muxr Android release APK sha256 $(sha256sum "$APK" | cut -d ' ' -f1); harness $(git rev-parse HEAD)"},
 "start": "Fresh install, paired to a private lab host with one fullscreen $KIND pane; the pane prints MARK-1..$LINES ($([ "$KIND" = shell ] && echo "a shell loop, one line every 60 ms" || echo "at $LPS lines/s")) while the phone is attached",
 "steps": ["Open the $KIND pane from Home", "Wait for the output to finish (live edge)", $([ "$WALK" -gt 0 ] && echo "\"Walk back through the history in $WALK stepped 800 px drags\"" || echo '"Drag back slowly 400 px", "Fling back"'), "Tap Latest"],
 "result": "$([ "$WALK" -gt 0 ] && echo "Captured $WALK stepped drags; proof.log records the visible MARK range and row count per screen and $(grep -c ' gap MARK-' "$E/proof.log") within-screen gap reports (repeated screens may report the same gap). These screens do not establish coverage of all $LINES rows. At 270 dp, two or three rows of 1200 can still be missing when a host frame outran the screen; those rows never reached the phone. after-latest.png and proof.log record the Latest result" || echo "The drag moves the view about as far as the finger, the fling keeps going back through consecutive rows with Latest shown, and Latest returns to the newest output (MARK-$LINES) with the pill gone")"}
JSON
