# Try muxr with sample agents before you pair

A browser with no computer paired lands on a demo, not an empty setup page: a
sample herd on "Umer's MacBook Pro" with three agents (one working, one needing
an answer, one idle), each opening a real-looking conversation, and a final
**Connect a machine** step that opens the two doors (`/connect`,
[two-doors-first-run.md](./two-doors-first-run.md)). All of
it is bundled fixtures: nothing is fetched, stored or written to a grant, and
the demo is replaced by the real Home the moment a pairing completes.

## Sub-features

- `sample-data-banner`: a "Sample data" pill and the demo computer name sit
  above the herd, so the page never reads as a connected machine.
- `sample-herd`: `zulu-2` (Claude Code · Sonnet 5.5, working · fixing the
  sign-in redirect), `kestrel` (Codex · GPT-6 Sol, needs you · approving the
  users migration), `ember` (Pi · Pi 2, idle · flaky-test sweep finished), each
  with provider, model and status, in that order.
- `sample-conversation`: tapping an agent replaces the herd with that agent's
  conversation (your turns as bubbles on the right, the agent's as plain text)
  and an **All agents** way back. The content is fixed seed text.
- `pair-step`: the demo always ends in one card — title, one sentence and the
  **Connect a machine** button that opens the two doors. It is the only call to
  action on the page.
- `web-only`: native first run opens straight on the doors; the demo renders
  only for `Platform.OS === 'web'` with no authenticated grant.
- `narrow-and-large-text`: at 270 dp and the largest text the rows drop their
  avatar and chevron and the wrapping text keeps whole words, so no word is
  split across lines.

## How to get to it (user POV)

Open the exported web build (or the installed PWA) in a browser that has never
paired a computer: the Demo header, the sample strip, the three agents and the
pair card are the first screen. Tap an agent, read, tap **All agents**, then
**Connect a machine** to reach the doors. Pairing from there is the same flow as
any other browser; nothing about the demo is claimed or stored.

## Driving it with the private stack

Preconditions: `yarn build && yarn web:export:selfhost` from this checkout,
then serve that very `apps/mobile/dist` with
`scripts/diagnostics/application/serveWebExport.mjs` on a free port (not
8792). No relay, host or Herdr is needed, and no grant may be stored in the
browser profile — use a task-owned `--user-data-dir`.

1. Launch a private standalone window: Chromium from
   `scripts/diagnostics/application/withPrivateXvfb.sh` with its own
   `--user-data-dir`, `--remote-debugging-port`, `--hide-scrollbars` and
   `--app=http://127.0.0.1:<port>/`; point chrome-devtools-axi at it with
   `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<debug-port>`.
   `location` must be the export origin, and the page must draw before any
   shot (`document.body.innerText` non-empty).
2. Matrix: `features/demoFirstRunPwaCells.sh <outDir>` reloads per cell for
   270 dp at text 2.0 and 360/390/445/1280/1440 at text 1.0, light and dark,
   shooting at rest and scrolled to the end, and running
   `visualCheck.mjs pwa-check` on every shot. It also writes the DOM facts per
   cell (sample-data pill, `Umer` computer name, three agents in order,
   Connect a machine step) so a cell that lost one of them fails loudly, then
   shoots the doors and both branches' web screens per cell.
3. Journey: `features/demoPwaJourney.sh <outDir>` samples
   `chrome-devtools-axi screenshot` frames, stamping each as it is taken, while
   it clicks the first agent, reads the conversation, scrolls down and back,
   clicks **All agents**, then **Connect a machine**, the **My computer** door
   and **Next: pair**; it fails unless the run really ends on `/my-computer`. Encode the clip with the recorded pacing:
   `ffmpeg -f concat -safe 0 -i <outDir>/frames.txt -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo-first-run.mp4`.
4. Read every shot and the clip: the pill and computer name, three agents with
   their statuses, the conversation, and the final My computer pair step. Any split
   word, clipped label or overlap at 270 dp/largest text fails the cell.

## Gotchas

- Rebuild the export after any change to the demo: the served bundle is the
  proof, and the service worker can hand back the previous shell — unregister
  workers and clear `caches` before capturing a new build.
- A CDP `Page.captureScreenshot` loop against this Chromium returns the same
  stale surface frame over and over; sample with `chrome-devtools-axi
  screenshot` instead (it is the command the matrix already trusts).
- `--app=` reported `display-mode: browser` in Chromium 151 on this host even
  though the window has no browser chrome; note what the browser actually
  reports instead of asserting standalone.
- The demo must never appear for a paired browser: pair once in a scratch
  profile and confirm Home, not the demo, is what opens.
- Native is unchanged by design; do not capture this screen there, and do not
  add a native entry to it without a product decision.
