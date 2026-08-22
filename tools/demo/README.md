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
node capture/take.mjs        # the shoot — needs a phone and a live agent
node capture/phone-after.mjs # the after pass: finished state, diff, herd
node build.mjs           # shots → lockup → assemble → sheet → leakcheck
```

`take` is the shoot: it runs the job once and records the desk and the phone
together. Everything after it works off `raw/take`, so `build.mjs` is a recut
and does not need the shoot set up again. That is why `take` is not part of the
default run.

## What each step does

| step | tool | output |
|---|---|---|
| `take` | herdr + `adb screenrecord` | `raw/take/desk.cast`, `raw/take/phone.mp4` — one continuous run of the job |
| `shots` | ffmpeg | `cut/shots/01…10.mp4`, each exactly the length `lib/film.mjs` declares |
| `lockup` | Playwright | `cut/shots/11.mp4`, the only authored frame in the film |
| `assemble` | ffmpeg | `raw/muxr-demo-1080.mp4`, `docs/demo/muxr-demo.mp4` (720p), `docs/demo/muxr-loop.webp` |
| `sheet` | ffmpeg | `review/sheet.png`, one frame per shot side by side |
| `leakcheck` | tesseract | reads all 1080 shipped frames and fails on anything private |
| `frames` | Playwright | `docs/play/store-assets/NN-<scene>.png`, 1080×1920 |

`lib/film.mjs` is the only thing that decides timing: it self-validates, and
`cut/assemble.mjs` refuses to join a shot whose length disagrees with it.
`lib/scenes.mjs` plays the same role for the store screenshots.

The 1080p master lands in `raw/muxr-demo-1080.mp4` and is deliberately not
tracked — thirty-six seconds of fine terminal text encodes to twenty-odd megabytes,
which does not belong in every clone. Upload that one to the site and the store
listing; the repo carries the 720p cut and the WebP.

## The film

36 seconds, one job, start to finish: Claude Code finds a refresh-token race,
asks to run the tests, nobody is at the desk, the same question appears on a
phone, someone taps Yes, and both screens move. `SPEC.md` holds the shot table,
the hard rules and every place the finished film deviates from them.

There is no device in this film and no captions. Every frame except the last is
the product's own output, cut from one take at real speed — no speed-up, no
recreation, no drawn UI. The one authored frame is the brand close, and it is
set in the app's own IBM Plex.

Two decisions carry the rest of it:

**One take, two recorders.** The desk and the phone start together and drift by
a single frame across ten minutes, so a phone timestamp *is* a desk timestamp.
That is what lets shot 05 put both screens in one frame across the tap and be
sure the desk really did react when it looks like it did.

**Poll the pane, don't stream it.** `herdr terminal session observe` is what the
app's live strip uses and it is deliberately frugal — on a hundred-second take
it sent thirty repaints and never sent the approval prompt at all. Fine for a
thumbnail, useless for a recording. `capture/deskpoll.mjs` polls
`herdr agent read` instead, which returns the whole rendered screen for about
two milliseconds a call, and writes each change as a cast frame. Same pane, same
output, sampled rather than streamed.

## Requirements

- An Android device or emulator on `adb`, running a build of `com.trymuxr.app`,
  **paired to a live host with real sessions**. A disconnected app screenshots
  the onboarding screen.
- `maestro`, `adb`, and `ffmpeg` on `PATH`.
- Node 22+.

## Things that will bite you

- **`agg` draws the cast header's row count, not the screen's.** The pane here
  is forty-eight rows, the header said twenty-three, and the render came out
  holding the last twenty-three — so the newest output sits at the *top* of the
  render and the composer trails off underneath. Anchoring the desk crop to the
  bottom frames the chrome and misses the work.
- **`-ss` landing exactly on a frame boundary desynchronises a synthetic
  `color` source**, and the composite comes back as a silent black frame rather
  than an error. Build the ground by `pad`ding a real layer instead. There is a
  size floor in `cut/shots.mjs` that stops the render if a frame comes out
  empty, because this shipped once already.
- **`uiautomator dump` and `adb screenrecord` fight over the device** and the
  dump is killed mid-take. Resolve every tap coordinate before the recorder
  starts — `capture/tap.mjs --print` does exactly that.
- **The phone's key row scrolls and does not spring back.** A hard-coded
  coordinate drifts onto a neighbouring key: a tap meant for `Enter` landed on
  `Up arrow` and walked the agent's answer from Yes to No, three takes running.
- **`adb screenrecord --time-limit` is a hard stop.** Three minutes is the
  default ceiling and it will end mid-job without saying so.
- **Every muxr surface prints the agent's working directory**, so a repo under
  `$HOME` puts the machine owner's username on the Herd screen, the session
  header and the agent's own banner. Film from a path that has no name in it.

- **`screenrecord` writes variable frame rate and only emits a frame when the
  screen changes.** A settled UI leaves seconds of timeline with no packets at
  all, so trimming the recording directly returns the single held frame — one
  clip came out 0.03 seconds long. Rebuild a constant frame rate *before*
  cutting the window (`fps=30,trim=…`, in that order), never after.
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
