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
| `capture` | Maestro + `adb screenrecord` | `raw/<scene>.mp4` + `raw/<scene>.png` |
| `cut` | ffmpeg | `reel/public/shots/<scene>.mp4`, one shot slot each |
| `frames` | Playwright | `docs/play/store-assets/NN-<scene>.png`, 1080×1920 |
| `reel` | Remotion + React Three Fiber | `docs/demo/muxr-demo.mp4` (720p), `docs/demo/muxr-loop.webp`, and a 1080p master in `raw/` |

`lib/scenes.mjs` is the single source of truth: what to film, the marketing
copy for each frame, and which scenes make the store set and the reel.

The 1080p master lands in `raw/muxr-demo-1080.mp4` and is deliberately not
tracked — forty seconds of fine terminal text encodes to twenty-odd megabytes,
which does not belong in every clone. Upload that one to the site and the store
listing; the repo carries the 720p cut and the WebP.

## Requirements

- An Android device or emulator on `adb`, running a build of `com.trymuxr.app`,
  **paired to a live host with real sessions**. A disconnected app screenshots
  the onboarding screen.
- `maestro`, `adb`, and `ffmpeg` on `PATH`.
- Node 22+.

## Things that will bite you

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
