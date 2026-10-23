#!/usr/bin/env bash
# The unpaired first screen in the installed PWA (tailscale-first-step.md): per
# cell (393 and 270 px, text 1.0 and 2.0, light and dark) it reloads the
# standalone --app window, shoots the screen at rest and scrolled to the end,
# reads the three step titles' order from the DOM and runs pwa-check on each
# shot. Text size F is page zoom, so a cell is a W/F x H/F viewport at DPR 2F.
#   CHROME_DEVTOOLS_AXI_BROWSER_URL=<devtools> firstRunPwaCells.sh <outDir>   (from the repo root)
set -u
wt=$PWD
out=$1
mkdir -p "$out"
order='(() => {
  const steps = ["Get Tailscale", "Get muxr on your computer", "Pair with your computer"];
  const all = [...document.querySelectorAll("div[dir=auto]")];
  const tops = steps.map((s) => all.find((e) => e.innerText.trim() === s || e.innerText.trim().slice(3) === s)?.getBoundingClientRect().top ?? null);
  const ok = tops.every((t, i) => t !== null && (i === 0 || t > tops[i - 1]));
  return `${ok ? "in order" : "NOT in order"}: ${steps.map((s, i) => `${s} @${tops[i] === null ? "missing" : Math.round(tops[i])}`).join(", ")}`;
})()'
toEnd='(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight; return "scrolled"; })()'
for theme in light dark; do for w in 393 270; do for f in 1.0 2.0; do
  name="firstrun-$w-$f-$theme"
  vw=$(awk "BEGIN{print int($w/$f)}"); vh=$(awk "BEGIN{print int(($w == 393 ? 864 : 594)/$f)}"); dpr=$(awk "BEGIN{print 2*$f}")
  view="${vw}x${vh}x${dpr},mobile,touch"
  chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1
  chrome-devtools-axi eval "location.reload()" >/dev/null 2>&1
  for _ in $(seq 1 30); do
    [ -n "$(chrome-devtools-axi eval 'document.body.innerText.trim().length > 0 ? "drawn" : ""' 2>/dev/null | grep -o drawn)" ] && break
    sleep 1
  done
  sleep 3
  chrome-devtools-axi emulate --viewport "$view" --color-scheme $theme >/dev/null 2>&1; sleep 2
  steps=$(chrome-devtools-axi eval "$order" 2>&1 | grep -o '\(NOT \)\?in order:.*' | head -1)
  chrome-devtools-axi screenshot "$out/$name.png" >/dev/null 2>&1
  pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
  chrome-devtools-axi eval "$toEnd" >/dev/null 2>&1; sleep 1
  chrome-devtools-axi screenshot "$out/$name-scrolled.png" >/dev/null 2>&1
  pwaEnd=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name-scrolled.png" "$name-scrolled" 2>&1)
  echo "$steps" > "$out/$name.steps.txt"; echo "$pwa" > "$out/$name.check.txt"; echo "$pwaEnd" > "$out/$name-scrolled.check.txt"
  echo "$name steps: $steps"
  echo "$pwa" | grep -E "^(DEFECT|clean|FAIL)" | cut -c1-200
  echo "$pwaEnd" | grep -E "^(DEFECT|clean|FAIL)" | sed 's/^/scrolled: /' | cut -c1-200
done; done; done
