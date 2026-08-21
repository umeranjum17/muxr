# demo studio

Capture, cut, and compose the store screenshots and the demo reel — from the
real app, on a real device, against a real host.

Nothing here is staged. muxr has no fixture or screenshot mode (the host's
`--fake` source renders an empty Herd), so every frame is a live pane on a
paired machine. That is the point: the shots are proof, not mockups.

## Run it

```bash
cd tools/demo
npm install              # not part of the yarn workspace — install on demand
npx playwright install chromium
node build.mjs           # stage → capture → cut → frames → reel
```

Individual steps: `node build.mjs capture`, `… cut`, `… frames`, `… reel`.

## What each step does

| step | tool | output |
|---|---|---|
| `stage` | — | copies the app's own fonts and marks into `reel/public` |
| `desk` | herdr | `lib/desk.json`, one pane's real scrollback for the desk shot |
| `capture` | Maestro + `adb screenrecord` | `raw/<theme>/<scene>.{mp4,png}`, both themes |
| `cut` | ffmpeg | `reel/public/shots/<theme>/<scene>.mp4`, one shot slot each |
| `frames` | Playwright | `docs/play/store-assets/NN-<scene>.png`, 1080×1920 |
| `reel` | Remotion + React Three Fiber + drei | `docs/demo/muxr-demo.mp4` (720p), `docs/demo/muxr-loop.webp`, and a 1080p master in `raw/` |

`lib/scenes.mjs` is the single source of truth: what to film, the marketing
copy for each frame, and which scenes make the store set and the reel.

The 1080p master lands in `raw/muxr-demo-1080.mp4` and is deliberately not
tracked — forty seconds of fine terminal text encodes to twenty-odd megabytes,
which does not belong in every clone. Upload that one to the site and the store
listing; the repo carries the 720p cut and the WebP.

## The film

There is no device in this film. A reference the owner picked — a launch film
in Spline's house style — turned out to differ structurally from a product
shot, not cosmetically:

- no bezel; pieces of the real UI float in the dark at different depths,
  tilted, with shallow depth of field
- the product's own pills are the motion vocabulary
- type is large enough to crop the frame, and a real UI element sometimes sits
  inline in the sentence
- colour arrives in bursts, and it comes from the product's own content

muxr already had the vocabulary: nav chips, `ctrl`/`shift`/`esc` terminal keys,
the composer, session rows with status dots. `capture/fragments.mjs` cuts them
out of the captures — declared, so a recapture reproduces them rather than
being re-cropped by hand — and the chip boundaries are *found* by scanning the
row rather than hard-coded, so a shifted row still works.

`reel/src/motion.ts` holds the one idea the film is built on: **depth is a
single number**. How blurred a layer is, how far it recedes into the ground,
and how much of the beat's drift it takes all come off it, so a layer is placed
by saying how far away it is.

`reel/src/Beats.tsx` is one component per beat. `reel/src/Layer.tsx` is the
floating fragment. `reel/src/Type.tsx` is the headline and the mono line.

Two things carry the mark. The title card assembles the wordmark one cell
column at a time, because the mark is a display matrix — `scripts/genBrand.sh`
rasterises it from a pixel font and knocks a gap out of every cell. And every
kicker carries a status dot in the app's own hues, which is the only colour the
film adds, at dot size, exactly as `components/ui.tsx` says colour should be
spent.

Nothing reads the wall clock. Frames render concurrently across browser tabs
whose clocks start at different instants, so any wall-time animation lands
somewhere different in every frame and the result vibrates. Every value comes
from `useCurrentFrame()`.

## Requirements

- An Android device or emulator on `adb`, running a build of `com.trymuxr.app`,
  **paired to a live host with real sessions**. A disconnected app screenshots
  the onboarding screen.
- `maestro`, `adb`, and `ffmpeg` on `PATH`.
- Node 22+.

## Things that will bite you

- **`screenrecord` writes variable frame rate and only emits a frame when the
  screen changes.** A settled UI leaves seconds of timeline with no packets at
  all, so trimming the recording directly returns the single held frame — one
  clip came out 0.03 seconds long. Rebuild a constant frame rate *before*
  cutting the window (`fps=30,trim=…`, in that order), never after.
- **Cut no longer than the shot plays.** A window longer than `timing.shot`
  spends the extra at its start, which is the navigation, and the shot never
  reaches the screen it is about.
- **Maestro has no sleep.** To hold on a screen, re-assert something on it in a
  `repeat` block: each iteration costs a hierarchy dump, which is the wait, and
  it touches nothing. Do not swipe to pass time — on the Inbox a swipe lands on
  a session row and opens it.
- **Pin the device.** A second emulator appearing mid-run breaks every adb call
  with `more than one device/emulator`. Set `ANDROID_SERIAL`; the harness passes
  it to both adb and Maestro, and refuses to start if two devices are attached
  and it is unset.

- **Maestro text selectors are full-match regexes.** `"recent commits"` does
  not match `25 recent commits`; write `".*recent commits"`.
- **`screenrecord` writes two `mett` metadata tracks** beside the video, so
  every ffmpeg step needs `-map 0:v:0`.
- **Maestro spends ten-odd seconds attaching before its first command.** The
  harness records when the first command actually runs and writes it to
  `raw/<scene>.json`; `cut` trims from there.
- **The herd reorders by activity**, so a row is never in the same place
  twice. Flows open a session through Search, by name.
- **Never deep-link `muxr://workspace/*` or `muxr://grid/*`.** Those two
  screens prefer the raw terminal title, which is user-written text that has no
  business on a store listing. Nothing in the app navigates to them.
- **Label every shell pane before filming.** An unlabelled pane falls back to
  `user@host:~/path` as its display name on the Herd.
- The emulator's package verifier has been seen disabling a sideloaded build
  mid-run; it surfaces as `launchApp failed: UNKNOWN`. `capture.mjs` re-enables
  the package before each run.

## Known gap: the voice scene

`capture/flows/voice.yaml` is written and correct, but the realtime overlay
blanks the whole app on 0.1.12 — the view tree empties and only a relaunch
recovers it. The scene is marked `store: false` in `lib/scenes.mjs`; flip it
back the moment that is fixed and rerun `capture` + `frames`.
