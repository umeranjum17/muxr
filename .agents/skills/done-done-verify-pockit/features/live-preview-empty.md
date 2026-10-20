# Read a Live preview with no output

A Live card whose pane has no frame never draws an empty black tile. It shows a
calm placeholder and a plain line saying there is nothing yet and why. A pane
that has live output still shows its terminal picture, unchanged.

## Sub-features

- `live-empty-no-output` a pane that has not printed anything yet: the placeholder and the line.
- `live-empty-output-ended` a pane whose output has ended (its read goes empty): the same placeholder.
- `live-live-control` a pane with output: the terminal text, exactly as before.

## How to get to it (user POV)

- Pair a computer whose herd has an agent pane with nothing on screen, then open Home and read the Live strip. Swipe to a busy pane to see the live picture.

## Driving it with the private stack

Preconditions:

- `yarn build` (for the host/relay/fake) and a release app (native) or the web
  export (PWA). The fake Herdr is the repo's own `perf/fake-herdr`, reached
  through `perf/lib/fakeStack.mjs`.
- Ask the fake for an empty pane with `startFakeStack({ emptyPanes: 1, ... })`:
  pane `w1:p1` then reads `''`. Add `emptyAfterMs` (e.g. `90000`) so that pane
  reads output first and goes empty after that many ms, proving output-ended.
  Keep `titleChurnHz: 0` so the titles and statuses are stable while capturing.
- Native: pair `muxr://pair#<code>` from `mintPairing()` on an owned emulator
  (see `home-header-name.md`). PWA: serve the web export on one origin, pair a
  private headless Chromium through `/pair` with a browser offer from the
  host's `pair.sock`, then reload to swap the base and branch exports while the
  same grant stays live.
- Capture the Home Live strip at 360dp and 270dp, light and dark, before the
  fix (base) and after (branch), for both empty states, plus one live-output
  control. Force a fresh read after `emptyAfterMs` by reloading the page.
- Pass: both empty states show the calm placeholder with the line, the line
  wraps inside the card with nothing clipped or overlapping, and a pane with
  output shows its terminal text unchanged.

## Gotchas

- `emptyPanes` marks the first N panes in the world; keep `panes`/`agents` at
  least N so the empty pane is an agent and reaches the Live strip.
- The fake's default read fabricates `<title>\nready.`, so a plain pane is
  never empty; the empty state only appears through `emptyPanes`.
- The empty state is the Live card's alone: `TerminalPreview` needs the
  `emptyState` prop, which small pane-grid tiles do not set.
- The PWA is a headless Chrome tab, not a home-screen-installed PWA; the
  browser fills the pairing offer through real typing, and a failed Pair uses
  the offer up.
- `emptyAfterMs` counts from the fake server start, so set it longer than the
  pairing and first capture take, or the control frame will already be empty.
