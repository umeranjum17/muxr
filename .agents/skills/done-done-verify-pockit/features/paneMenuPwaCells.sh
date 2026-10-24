#!/usr/bin/env bash
# The pane menu in the installed PWA (pane-menu.md): per cell (270 and 393 px by
# default, text 1.0 and 2.0 as page zoom, dark and light) it reloads the paired --app
# window on the agent, opens Pane actions, shoots the menu at rest and scrolled
# to its end through pwa-check, then scrolls Usage into the menu's view, clicks
# it and checks the Usage screen opened. Exits 1 when Usage does not open.
# pwa-check also reports the screen the open menu covers (every control behind
# it is "covered") and the lab's /tmp folder path; judge its leads against
# main's run of the same cell (`diff` the sorted .check.txt), not as they stand.
#   CHROME_DEVTOOLS_AXI_SESSION=<s> paneMenuPwaCells.sh <outDir> <agent url>   (from the repo root)
set -u
wt=$PWD
out=$1
agent=$2
mkdir -p "$out"
defects=0
axi() { chrome-devtools-axi "$@" 2>&1; }
# The menu's scroller: the nearest scrolling ancestor of its Find in output row.
scroller='(() => { let el = document.querySelector("[aria-label=\"Find in output\"]"); while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement; return el; })()'
# PANE_MENU_WIDTHS picks the widths (default 270 393); a desktop width (1000
# and over) runs at text 1.0 only, as a desktop window with no touch.
declare -A HEIGHT=([270]=594 [360]=780 [390]=844 [393]=864 [445]=964 [1280]=800 [1440]=900)
for theme in dark light; do for w in ${PANE_MENU_WIDTHS:-270 393}; do for f in 1.0 2.0; do
  desktop=$([ "$w" -ge 1000 ] && echo 1 || echo 0)
  [ "$desktop" = 1 ] && [ "$f" != 1.0 ] && continue
  name="menu-$w-$f-$theme"
  h=${HEIGHT[$w]}
  if [ "$desktop" = 1 ]; then view="${w}x${h}x1"; else view="$(awk "BEGIN{printf \"%dx%dx%d\", $w/$f, $h/$f, 2*$f}"),mobile,touch"; fi
  axi emulate --viewport "$view" --color-scheme $theme >/dev/null
  axi eval "location.href = '$agent'" >/dev/null; sleep 8
  axi emulate --viewport "$view" --color-scheme $theme >/dev/null; sleep 1
  axi eval "document.querySelector('[aria-label=\"Terminal view\"]')?.click()" >/dev/null; sleep 2
  # A loaded page can take the click before ⋮ answers it: click until the menu shows.
  for try in 1 2 3 4 5; do
    axi eval "document.querySelector('[aria-label^=\"Pane actions\"]')?.click()" >/dev/null; sleep 2
    axi eval "!!document.querySelector('[aria-label=\"Find in output\"]')" | grep -q true && break
  done
  axi screenshot "$out/$name.png" >/dev/null
  pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
  echo "$pwa" > "$out/$name.check.txt"; echo "$name: $(echo "$pwa" | grep -E '^(DEFECT|clean|FAIL)' | cut -c1-200)"
  axi eval "(() => { const s = $scroller; if (!s) return 'no scroller'; s.scrollTop = s.scrollHeight; return 'scrolled'; })()" >/dev/null; sleep 1
  axi screenshot "$out/$name-scrolled.png" >/dev/null
  pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name-scrolled.png" "$name-scrolled" 2>&1)
  echo "$pwa" > "$out/$name-scrolled.check.txt"; echo "$name-scrolled: $(echo "$pwa" | grep -E '^(DEFECT|clean|FAIL)' | cut -c1-200)"
  # Back to the top, then reach Usage: scroll its row into the menu's view and click it.
  axi eval "(() => { const s = $scroller; if (s) s.scrollTop = 0; const u = document.querySelector('[aria-label=\"Usage\"]'); u.scrollIntoView({ block: 'nearest' }); const r = u.getBoundingClientRect(), b = (s ?? document.body).getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom + 1 ? 'in view' : 'out of view'; })()" > "$out/$name-usage.txt"; sleep 1
  axi eval "document.querySelector('[aria-label=\"Usage\"]').click()" >/dev/null; sleep 3
  where=$(axi eval "location.pathname")
  if echo "$where" | grep -q '/usage'; then echo "$name: Usage opened from the pane menu" | tee -a "$out/$name-usage.txt"
  else echo "DEFECT $name: clicking Usage in the pane menu never opened Usage ($where)" | tee -a "$out/$name-usage.txt"; defects=$((defects + 1)); fi
done; done; done
echo "defects: $defects"
[ "$defects" -eq 0 ]
