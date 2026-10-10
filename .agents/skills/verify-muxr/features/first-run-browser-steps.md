# First-run browser pairing steps (installed PWA)

The first screen an unpaired browser-mode client shows (`FirstRunConnection`,
browser branch): two numbered step cards in one style — Step 1 "On your
computer" with the copyable install command, Step 2 "Paste the browser link"
with a "Recommended" tag and a primary paste button inside the card — and no
"Other ways" duplicate or camera/scan hint. The native branch (QR scan step,
setup details, paste/SSH routes) is a different surface and must stay as it
was.

## How to get to it (user POV)

Install the muxr web build as a PWA (or serve the export) on a fresh profile
with no stored grant and open it: the first-run screen appears. Press the Step
2 button: the paste prompt opens with the `muxr pair --browser` command in its
message, word-joined so the flag never breaks across lines.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` isolation contract. Build the export from
the candidate commit (`yarn web:export`), serve it with
`MUXR_WEB_EXPORT_DIR=<task dir> MUXR_WEB_PORT=<free port>
node scripts/diagnostics/application/serveWebExport.mjs` (never 8792), and
drive it with chrome-devtools-axi against a standalone Chromium app window
(`--app=<origin>`, own user-data-dir, remote debugging port; a task-owned
profile keeps the client unpaired).

1. Verify the served bundle is the candidate build before trusting any
   capture: `grep -o 'index-[a-f0-9]*\.js' dist/index.html`, then confirm the
   chunk contains the branch's new strings (e.g. the paste-button icon) and
   none of the removed ones (`Use this if you can't point`). A stale dist or
   service-worker cache shows the old screen; clear the profile's service
   worker and caches (`navigator.serviceWorker` + `caches`) before recapturing.
2. Emulate `--viewport "<w>x<h>x2,mobile,touch" --color-scheme <theme>` in ONE
   call per shot: a scheme-only `emulate` call resets the viewport override,
   and a `location.reload()` drops device emulation entirely. Then screenshot
   `--full-page`. Widths: 393 and 270; also 208 (= 270/1.3) as the large-text
   stress, because react-native-web pins `fontScale` to 1 so browser zoom is
   the only faithful text-scale equivalent. Themes: light and dark.
3. Press the Step 2 button (snapshot → click the "Paste the browser link"
   button) and capture the open prompt; at 208 px also fill the input with a
   long relay link and capture again. The button shows its label again after
   Cancel.
4. DOM checks beat pixels for wrap claims: `document.createRange()` over the
   message text must keep `muxr pair --browser` on one client-rect line at
   393, and the flag must not split across lines at 208 either;
   `document.documentElement.scrollWidth === window.innerWidth` proves no
   horizontal overflow.
5. Native branch unchanged: build the release APK from the same commit
   (throwaway keystore is fine; `FM_MEM_JOB_GB=16` under the gradle lock),
   boot a task-owned AVD headless, and — because a fresh emulator can still
   auto-pair to a lab relay reachable at 10.0.2.2 — `adb root`, drop OUTPUT to
   10.0.2.2/10.0.2.3, `pm clear` the app, relaunch, and capture the first-run
   screen showing the QR-scan step, setup details and Other-ways routes.
   Kill the emulator by exact serial (`adb -s <serial> emu kill`).

## Durable proof

- before/after PNGs per width and theme, named `firstrun-steps-before/after-<width>-<theme>.png`
  plus the paste-prompt and long-link extremes, and one
  `firstrun-native-unchanged-branch.png`, all full-page, reviewed for clipped
  text, overlap, stray markup and wrong wording.
- The paste prompt keeps the `--browser` flag unbroken (word joiners in the
  message string; extend `FirstRunConnection.spec.ts`'s
  `stringContaining(...)` expectation when the wording changes).
