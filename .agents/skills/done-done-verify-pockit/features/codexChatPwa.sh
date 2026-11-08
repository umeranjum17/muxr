#!/usr/bin/env bash
# Capture an already paired private real-Codex lab (chat-view.md), through AXI.
set -euo pipefail
source "${MUXR_CODEX_BROWSER_ENV:?task-owned AXI environment file}"
out=${DONE_DONE_EVIDENCE_ROOT:?}
phase=${CODEX_CHAT_PHASE:-after}
ax() { chrome-devtools-axi "$@"; }
ax eval 'location.assign("/")' >/dev/null
sleep 3
ax eval '(() => { const e=[...document.querySelectorAll("[aria-label]")].find(e=>/^Open Check shipping output,/.test(e.getAttribute("aria-label"))); if(!e) throw Error("lab agent missing"); e.click(); })()' >/dev/null
sleep 3
for cell in '270:270:594:1' '390:390:844:1' '270-large:135:297:2' '1280:1280:800:1'; do
  IFS=: read -r name width height font <<< "$cell"
  themes="dark light"
  [ "$phase" != before ] || themes=dark # The terminal deliberately stays dark in both app themes.
  for theme in $themes; do
    ax emulate --viewport "${width}x${height}x2,mobile,touch" --color-scheme "$theme" >/dev/null
    sleep 2
    if [ "$phase" = after ]; then
      ax eval '(() => { const e=[...document.querySelectorAll("[aria-label]")].find(e=>e.getAttribute("aria-label")==="Chat view"); if(!e) throw Error("Codex chat unavailable"); e.click(); })()' >/dev/null
      sleep 2
      ax eval '(() => { if(!document.body.innerText.includes("Shipping check")) throw Error("Codex result missing"); return {standalone:matchMedia("(display-mode: standalone)").matches,scrollContainers:[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight&&/auto|scroll/.test(getComputedStyle(e).overflowY)).length}; })()' > "$out/$name-$theme-facts.txt"
    fi
    ax screenshot "$out/$phase-codex-$name-$theme.png" >/dev/null
  done
done
ax eval '(() => { const e=[...document.querySelectorAll("[aria-label]")].find(e=>e.getAttribute("aria-label")==="Terminal view"); if(!e) throw Error("terminal fallback missing"); e.click(); })()' >/dev/null
ax emulate --viewport '390x844x2,mobile,touch' --color-scheme dark >/dev/null
sleep 2
ax screenshot "$out/$phase-codex-terminal.png" >/dev/null
node --input-type=module - "$out" "$phase" <<'JS'
import { writeFileSync, readFileSync } from 'node:fs';
const [out, phase] = process.argv.slice(2);
writeFileSync(`${out}/steps.json`, JSON.stringify({target:{version:JSON.parse(readFileSync('package.json')).version},start:'Installed PWA paired to a task-owned real Herdr/Codex lab, private relay and MUXR_HOME',steps:['Open Check shipping output from Home','Read the same real Codex conversation at phone size in light and dark','Switch to Terminal'],result:phase==='before'?'Codex has only a terminal; long tool output dominates':'Codex offers the existing wrapped Markdown chat with collapsed tool steps and a raw terminal fallback'}));
JS
