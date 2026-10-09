# See the themed splash on a cold PWA start

The installed web client paints a themed splash from the first frame, so a cold
start shows the muxr mark on the system theme's background instead of a blank
body or the manifest's old black flash. The splash is CSS and one inline SVG
(the native mark from `public/favicon.svg`) written into the shell by
`scripts/release/application/finalizeWebExport.mjs`; it follows
`prefers-color-scheme` (light `#F2F2F7`, dark `#000000`) and is removed the
moment React mounts `#root`, with no script, so it can never cover the app's own
error or offline screen.

## Sub-features

- The finalized shell (`apps/mobile/dist/index.html`) carries
  `<style id="muxr-splash-style">` and `<div id="muxr-splash">` with the mark,
  and no new script (the CSP `script-src 'self'` still holds).
- The background and mark flip with `prefers-color-scheme`: light `#F2F2F7`
  with a dark mark, dark `#000000` with a light mark.
- `#root:not(:empty)+#muxr-splash{display:none}` removes the splash the instant
  React mounts, so it never covers the app or PR 752's offline shell.
- `manifest.webmanifest` `background_color` is `#F2F2F7`, so the OS launch
  splash never flashes black on a light phone.

## How to get to it (user POV)

Install the web client to the home screen (or open the export in a standalone
window) and cold-start it. The mark appears on the correct system background
immediately, stays through the bundle parse, then hands off to the app's first
screen with no blank frame. Drop the network and relaunch: the worker serves the
cached shell and the app's own offline state appears, not a splash stuck on top.

## Driving it with the private stack

Preconditions: build the export (`yarn build && yarn web:export:selfhost`) and
serve that very `apps/mobile/dist` with the repo static server on a free port
(not 8792). No host, relay or Herdr is needed.

1. `MUXR_WEB_EXPORT_DIR=<repo>/apps/mobile/dist MUXR_WEB_PORT=<free> node scripts/diagnostics/application/serveWebExport.mjs`,
   read `web export on http://127.0.0.1:<port>` from its own stdout, and confirm
   `curl -fsS http://127.0.0.1:<port>/index.html` contains `id="muxr-splash"` and
   `@media (prefers-color-scheme:dark)`, and `.../manifest.webmanifest` reads
   `"background_color": "#F2F2F7"`.
2. Launch a private standalone window: a Chromium with a task-owned
   `--user-data-dir` inside a task-owned Xvfb display, plus
   `--remote-debugging-port`, `--app=http://127.0.0.1:<port>/`; point
   chrome-devtools-axi at it with
   `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<debug-port>`. In the page,
   `matchMedia('(display-mode: standalone)').matches` must be `true`.
3. First paint, no JS: `Emulation.setScriptExecutionDisabled(true)`, set metrics
   393 px and 270 px wide, set `prefers-color-scheme` light then dark, navigate,
   and screenshot. Each capture shows `#muxr-splash` at `display:flex` over
   `rgb(242,242,247)` (light) or `rgb(0,0,0)` (dark) — the splash needs no script.
4. Throttled cold start: `Emulation.setCPUThrottlingRate(6)` and an emulated
   Slow 4G condition, clear the worker and `caches` (cold), navigate, and sample
   `body` background plus `#muxr-splash` `display` while the bundle loads. The
   background stays on the theme the whole wait, `#root` children go `0 → 1`, and
   the splash flips to `display:none` with no white/black frame between. Record
   the samples into a short clip per theme.
5. Offline hand-off: with the window loaded online once (worker active,
   `muxr-shell-<hash>` cached), stop the static server (kill only that exact
   PID), reload, and confirm `#root` has children, the splash is `display:none`,
   and the app's own screen renders instead of a browser error page.
6. Native comparison: render `sources/assets/images/splash-android-light.png`
   and `-dark.png` contained in a 393x844 frame as the native reference; the web
   mark is the same wordmark (reused from `public/favicon.svg`).

## Gotchas

- A plain tab is not enough: `--app=` reports `display-mode: standalone`; a
  headless tab does not.
- chrome-devtools-axi has no screencast command. Capture first paint with a
  short CDP `Page.captureScreenshot` loop (or `Emulation.setScriptExecutionDisabled`
  for the no-JS first frame) over the same `--remote-debugging-port`; the stills
  plus the sampled `display` are the proof.
- Clear both the worker registration and `caches` for a real cold start; a warm
  worker can serve the shell before `Page.navigate` observes the network.
- The manifest takes one `background_color`; it is the light splash so a light
  phone never flashes black. A dark phone shows a brief light OS splash before
  the themed shell paints — the trade is recorded in the PR.
- The splash must stay out of `#root` as a sibling: inside `#root` it would
  immediately match `:not(:empty)` and never show, and wrapping `#root` would
  break the app's mount point.
