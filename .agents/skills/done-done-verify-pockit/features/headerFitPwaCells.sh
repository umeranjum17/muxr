#!/usr/bin/env bash
# The agent header in the installed PWA (chat-header-fit.md): per cell (chat and
# terminal view, 360 and 390 px, dark and light) it reloads the paired --app
# window open on the agent, picks the view, reads the title button twice around
# a screenshot (a change between the reads is UNSTABLE), checks every text in it
# ends inside it and clear of the toggle, pane count and ⋮, and runs pwa-check.
#   CHROME_DEVTOOLS_AXI_SESSION=<s> headerFitPwaCells.sh <outDir>   (from the repo root)
set -u
wt=$PWD
out=$1
mkdir -p "$out"
check='(() => {
  const title = [...document.querySelectorAll("[aria-label$=\"Open panes\"]")].find((e) => !/^Pane \d/.test(e.getAttribute("aria-label")) && e.getBoundingClientRect().width > 0);
  const controls = ["Chat view", "Terminal view", "Pane actions"].map((l) => document.querySelector(`[aria-label="${l}"]`)).concat([...document.querySelectorAll("[aria-label^=\"Pane \"][aria-label$=\"Open panes.\"]")]).filter(Boolean).map((e) => e.getBoundingClientRect());
  const box = title.getBoundingClientRect(), out = [];
  for (const el of title.querySelectorAll("div[dir=auto], span")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || !el.innerText.trim()) continue;
    if (r.right > box.right - 1) out.push(`cut by the title button edge: "${el.innerText.slice(0, 30)}"`);
    for (const c of controls) if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) out.push(`over a control: "${el.innerText.slice(0, 30)}"`);
  }
  return out.length ? out.join(" | ") : `clean: ${[...title.querySelectorAll("div[dir=auto]")].map((e) => e.innerText).join(" / ")}`;
})()'
for theme in dark light; do for w in 360 390; do for view in chat terminal; do
  name="$view-$w-1.0-$theme"
  chrome-devtools-axi emulate --viewport "${w}x844x3,mobile,touch" --color-scheme $theme >/dev/null 2>&1
  chrome-devtools-axi eval "location.reload()" >/dev/null 2>&1; sleep 7
  chrome-devtools-axi emulate --viewport "${w}x844x3,mobile,touch" --color-scheme $theme >/dev/null 2>&1; sleep 1
  label=$([ $view = chat ] && echo "Chat view" || echo "Terminal view")
  chrome-devtools-axi eval "document.querySelector('[aria-label=\"$label\"]').click()" >/dev/null 2>&1; sleep 3
  first=$(chrome-devtools-axi eval "$check" 2>&1 | head -1); sleep 2
  chrome-devtools-axi screenshot "$out/$name.png" >/dev/null 2>&1
  header=$(chrome-devtools-axi eval "$check" 2>&1 | head -1)
  [ "$first" = "$header" ] || header="UNSTABLE: $first -> $header"

  pwa=$(node "$wt/.agents/skills/done-done-verify-pockit/features/visualCheck.mjs" pwa-check "$out/$name.png" "$name" 2>&1)
  echo "$header" > "$out/$name.header.txt"; echo "$pwa" > "$out/$name.check.txt"
  echo "$name header: $header"; echo "$pwa" | grep -E "^(DEFECT|clean|FAIL)" | cut -c1-200
done; done; done
