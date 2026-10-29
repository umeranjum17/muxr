#!/usr/bin/env bash
# The demo-first screen an unpaired browser lands on (pwa-demo-first-run.md):
# per cell it reloads the standalone --app window, reads the sample herd and the
# pair step out of the DOM, shoots the screen at rest and scrolled to the end,
# and runs pwa-check on each shot. Text size F is page zoom, so a cell is a
# W/F x H/F viewport at DPR 2F.
#   CHROME_DEVTOOLS_AXI_BROWSER_URL=<devtools> [MUXR_DEMO_URL=...] demoFirstRunPwaCells.sh <outDir>
#   (from the repo root)
set -u
wt=$PWD
failures=0
out=$1
mkdir -p "$out"
facts='(() => {
  const text = document.body.innerText;
  const agents = ["zulu-2", "kestrel", "ember"];
  const tops = agents.map((name) => {
    const el = [...document.querySelectorAll("div[dir=auto]")].find((e) => e.innerText.trim() === name);
    return el === undefined ? null : Math.round(el.getBoundingClientRect().top);
  });
  const ordered = tops.every((top, i) => top !== null && (i === 0 || top > tops[i - 1]));
  const pieces = [
    text.includes("Sample data") ? "sample-data pill" : "NO sample-data pill",
    text.includes("Umer") ? "Umer computer" : "NO demo name",
    ordered ? "3 agents in order" : `agents unordered: ${tops.join(",")}`,
    text.includes("Connect a machine") ? "connect step" : "NO connect step",
  ];
  return pieces.join(" | ");
})()'
# A fresh browser has no selected page, and every command below acts on the
# selected one: open the export, then select that tab explicitly (a browser
# holding two tabs selects neither by itself).
chrome-devtools-axi open "${MUXR_DEMO_URL:-http://127.0.0.1:8911/}" >/dev/null 2>&1
sleep 2
page=$(chrome-devtools-axi pages 2>/dev/null | awk -F, '{print $1}' | tail -1 | tr -d ' ')
[ -n "$page" ] && chrome-devtools-axi selectpage "$page" >/dev/null 2>&1
toEnd='(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight; return "scrolled"; })()'
# width:font:height — 270 dp at the largest text is the narrow/extreme cell,
# the rest are the phone and desktop widths this screen ships at.
for cell in 270:2.0:594 360:1.0:800 390:1.0:844 445:1.0:900 1280:1.0:900 1440:1.0:1000; do
  w=${cell%%:*}; rest=${cell#*:}; f=${rest%%:*}; h=${rest##*:}
  for theme in light dark; do
    name="demo-firstrun-$w-$f-$theme"
    vw=$(awk "BEGIN{print int($w/$f)}"); vh=$(awk "BEGIN{print int($h/$f)}"); dpr=$(awk "BEGIN{print 2*$f}")
    view="${vw}x${vh}x${dpr},mobile,touch"
    chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1
    chrome-devtools-axi eval "location.reload()" >/dev/null 2>&1
    for _ in $(seq 1 30); do
      [ -n "$(chrome-devtools-axi eval 'document.body.innerText.trim().length > 0 ? "drawn" : ""' 2>/dev/null | grep -o drawn)" ] && break
      sleep 1
    done
    sleep 3
    chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1; sleep 2
    seen=$(chrome-devtools-axi eval "$facts" 2>&1 | sed -n 's/^result: "\(.*\)"$/\1/p' | head -1)
    chrome-devtools-axi screenshot "$out/$name.png" >/dev/null 2>&1
    pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
    chrome-devtools-axi eval "$toEnd" >/dev/null 2>&1; sleep 1
    chrome-devtools-axi screenshot "$out/$name-scrolled.png" >/dev/null 2>&1
    pwaEnd=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name-scrolled.png" "$name-scrolled" 2>&1)
    echo "$seen" > "$out/$name.facts.txt"; echo "$pwa" > "$out/$name.check.txt"; echo "$pwaEnd" > "$out/$name-scrolled.check.txt"
    # A page that drew nothing (or an error screen) still passes the pixel
    # leads, so the DOM facts are the gate: one missing piece fails the cell.
    if [ -z "$seen" ] || printf '%s' "$seen" | grep -q 'NO \|unordered'; then
      echo "FAIL $name facts: $seen"; failures=$((failures + 1))
    else
      echo "$name facts: $seen"
    fi
    printf '%s' "$pwa" | grep -q '^clean' || failures=$((failures + 1))
    printf '%s' "$pwaEnd" | grep -q '^clean' || failures=$((failures + 1))
    echo "$pwa" | grep -E "^(DEFECT|clean|FAIL)" | cut -c1-200
    echo "$pwaEnd" | grep -E "^(DEFECT|clean|FAIL)" | sed 's/^/scrolled: /' | cut -c1-200
  done
done
# The conversation state of the same screen: the first agent opened at the phone
# width and at the narrow/largest-text cell, at rest and scrolled to the pair
# card, so the sample transcript and its way back are covered too.
conversation='(() => {
  document.querySelector("[role=button][aria-label^=\"zulu-2\"]").click();
  return "opened";
})()'
back='(() => { document.querySelector("[role=button][aria-label=\"Back to all demo agents\"]").click(); return "back"; })()'
for cell in 270:2.0:594 390:1.0:844; do
  w=${cell%%:*}; rest=${cell#*:}; f=${rest%%:*}; h=${rest##*:}
  vw=$(awk "BEGIN{print int($w/$f)}"); vh=$(awk "BEGIN{print int($h/$f)}"); dpr=$(awk "BEGIN{print 2*$f}")
  view="${vw}x${vh}x${dpr},mobile,touch"
  for theme in light dark; do
    name="demo-conversation-$w-$f-$theme"
    chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1
    chrome-devtools-axi eval "location.reload()" >/dev/null 2>&1
    for _ in $(seq 1 30); do
      [ -n "$(chrome-devtools-axi eval 'document.body.innerText.trim().length > 0 ? "drawn" : ""' 2>/dev/null | grep -o drawn)" ] && break
      sleep 1
    done
    sleep 3
    chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1; sleep 2
    chrome-devtools-axi eval "$conversation" >/dev/null 2>&1; sleep 2
    said=$(chrome-devtools-axi eval "document.body.innerText.includes('Safari loops on the sign-in redirect')" 2>&1 | head -1)
    case "$said" in *true*) ;; *) echo "FAIL $name facts: no sample transcript"; failures=$((failures + 1));; esac
    chrome-devtools-axi screenshot "$out/$name.png" >/dev/null 2>&1
    pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
    chrome-devtools-axi eval "$toEnd" >/dev/null 2>&1; sleep 1
    chrome-devtools-axi screenshot "$out/$name-scrolled.png" >/dev/null 2>&1
    pwaEnd=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name-scrolled.png" "$name-scrolled" 2>&1)
    echo "$pwa" > "$out/$name.check.txt"; echo "$pwaEnd" > "$out/$name-scrolled.check.txt"
    printf '%s' "$pwa" | grep -q '^clean' || failures=$((failures + 1))
    printf '%s' "$pwaEnd" | grep -q '^clean' || failures=$((failures + 1))
    echo "$pwa" | grep -E "^(DEFECT|clean|FAIL)" | cut -c1-200
    echo "$pwaEnd" | grep -E "^(DEFECT|clean|FAIL)" | sed 's/^/scrolled: /' | cut -c1-200
    chrome-devtools-axi eval "$back" >/dev/null 2>&1; sleep 1
  done
done
# The screens the demo's last step leads to (two-doors-first-run.md): the two
# doors, My computer's Get ready and Pair, and the Boat door's browser notice,
# at every cell, at rest and scrolled, each with the words it must show.
screens='connect|Connect a machine|My computer|Cloud machine · Boat|from $0.018 an hour
my-computer|Get ready|about 2 min|Get Tailscale|Next: pair
my-computer?step=pair|Pair with your computer|Private link or pairing code|Example words|Start an agent
cloud-computer|Your cloud computer|Set up from the muxr phone app'
for cell in 270:2.0:594 360:1.0:800 390:1.0:844 445:1.0:900 1280:1.0:900 1440:1.0:1000; do
  w=${cell%%:*}; rest=${cell#*:}; f=${rest%%:*}; h=${rest##*:}
  vw=$(awk "BEGIN{print int($w/$f)}"); vh=$(awk "BEGIN{print int($h/$f)}"); dpr=$(awk "BEGIN{print 2*$f}")
  view="${vw}x${vh}x${dpr},mobile,touch"
  for theme in light dark; do
    while IFS='|' read -r path words; do
      slug=$(printf '%s' "$path" | tr '?=' '--')
      name="web-$slug-$w-$f-$theme"
      chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1
      chrome-devtools-axi eval "location.assign('/$path')" >/dev/null 2>&1
      for _ in $(seq 1 30); do
        [ -n "$(chrome-devtools-axi eval 'document.body.innerText.trim().length > 0 ? "drawn" : ""' 2>/dev/null | grep -o drawn)" ] && break
        sleep 1
      done
      sleep 3
      chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1; sleep 2
      missing=$(chrome-devtools-axi eval "(() => { const text = document.body.innerText; return '$words'.split('|').filter((word) => !text.includes(word)).join(', ') || 'none'; })()" 2>&1 | sed -n 's/^result: "\(.*\)"$/\1/p' | head -1 | tr -d '\\"')
      if [ "$missing" != none ]; then echo "FAIL $name facts: missing ${missing:-everything}"; failures=$((failures + 1)); else echo "$name facts: all words shown"; fi
      chrome-devtools-axi screenshot "$out/$name.png" >/dev/null 2>&1
      pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
      chrome-devtools-axi eval "$toEnd" >/dev/null 2>&1; sleep 1
      chrome-devtools-axi screenshot "$out/$name-scrolled.png" >/dev/null 2>&1
      pwaEnd=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name-scrolled.png" "$name-scrolled" 2>&1)
      echo "$pwa" > "$out/$name.check.txt"; echo "$pwaEnd" > "$out/$name-scrolled.check.txt"
      printf '%s' "$pwa" | grep -q '^clean' || failures=$((failures + 1))
      printf '%s' "$pwaEnd" | grep -q '^clean' || failures=$((failures + 1))
      echo "$pwa" | grep -E "^(DEFECT|clean|FAIL)" | cut -c1-200
      echo "$pwaEnd" | grep -E "^(DEFECT|clean|FAIL)" | sed 's/^/scrolled: /' | cut -c1-200
    done <<< "$screens"
  done
done
echo "cells: $((failures)) failing check(s)"
[ "$failures" -eq 0 ] || exit 1
