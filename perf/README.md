# Release performance gate

For bounded PR review, use [the manual emulator smoke gate](PR_GATE.md). It
requires matching APK/native-patch provenance and mounted document, terminal,
graphics and Usage flows. The longer gate below remains the gesture/soak check.

`yarn perf` drives the release APK on a real device against a real relay and a
real host, and fails on the signals that shipped broken software: a saturated JS
thread, a dead React runtime, a frozen screen, runaway memory.

Relay, host and app are the builds we ship. Herdr is third party, so the gate
brings its own: `perf/fake-herdr` speaks Herdr's three wire seams (the JSON-RPC
control socket, the `HERDR_BIN` CLI, the protocol-20 graphics socket), which
makes the load identical run to run and means the gate never touches the desk
you work on. Conformance against the real Herdr belongs to `yarn check`
(`scripts/diagnostics/application/checkHerdrE2E.mjs`), which runs when a Herdr
socket exists.

It lives outside `scripts/` on purpose. Everything under `scripts/` is copied
into the published CLI artifact by `scripts/release/application/pack.mjs`; this
harness needs adb, an emulator and Maestro, and belongs to maintainers, not to
users' installs.

## Run it

```bash
yarn perf                                  # build, copy to /tmp/muxr-<ver>-vc<N>-<abi>.apk, install, pair, load, measure
yarn perf --apk /tmp/muxr-0.1.26-vc78-x86_64.apk
yarn perf --record docs/perf/0.1.26.json   # write release evidence
yarn perf --profile emulator               # emulator LIMITS column (default)
yarn perf --profile device                 # real-device LIMITS column
yarn perf --keep-load                      # leave the stack up to poke at it
```

The APK Gradle last wrote is not what the evidence records. The gate copies it to a
versioned path (`/tmp/muxr-<versionName>-vc<versionCode>-<abi>.apk`) and installs
that file. `device.versionCode`, `device.versionName` and `device.signerDigest`
(apksigner SHA-256) say what actually landed.


Prerequisites, all checked in preflight with a named failure:

- an Android device or the `muxr_sandbox` emulator on adb
- Maestro (`mise x maestro@cli-2.7.0`)
- `yarn build`, since the gate spawns `apps/relay/dist` and `apps/host/dist`

## What it measures, and why only these signals

| Signal | Source | Hard fail |
| --- | --- | --- |
| JS thread busy | `/proc/<pid>/task/<tid>/stat` deltas for `mqt_v_js` | over 60% emulator / 45% device in any phase |
| JS busy delta | gesture phase minus `idle on the herd` | native +15 / +10; terminal +25 / +20 |
| Runtime liveness | the `mqt_v_js` thread exists at the end | gone |
| React update depth | `Maximum update depth exceeded` in logcat | any occurrence |
| Frame liveness | `Total frames rendered` from gfxinfo | no frames for 30 s |
| Gesture jank | gfxinfo reset before a bout, wait until frames are 0, read after | janky 20% / 3%, p95 100 / 17 ms, p99 250 / 34 ms, >4 frames 3% / 0. An empty window (0 frames) fails as `no frames in window`, not as a 4950 ms percentile — dumpsys writes that sentinel into an empty histogram |

| Frames dropped | `framestats` Flags=0 and completed − intended > 2 frames | 12% / 3% of a fling |
| Gesture notches dropped | host `graphics.pipeline` `notchesDropped` for the bout | reported beside `gestureDroppedPercent`, never gated. The governor caps intent at 8; a fling that under-travels with `notchesDropped > 0` was bounded by frames in flight, not a slow one |
| Input-to-first-movement | `/proc/uptime` in the same `adb shell` as the swipe, then first input `framestats` row | p95 120 / 60 ms |
| Missed vsync | gfxinfo delta per fling | 3 / 1 |
| Accidental owners | phone trail `document.navigate` / agent-page during a vertical bout | any |
| Content moved | `screencapRaw` of the scrollable rect, mean |Δ| ≥ 8/255; strip card label, document gutter line, terminal trail | injected at intended velocity and the surface did not move |
| Terminal fling | phone trail `terminal.scroll-latency`, `terminal.scroll-rows`, `terminal.scroll-clamped` | p95 250 / 200 ms, < 40 / 60 rows/s, any clamp |
| Graphics fling | host `graphics.pipeline` bout-scoped `notchesSent` × 3 | < 9 rows/s |
| Zoom | phone trail `terminal.resize COLSxROWS cell=WxH` | exactly 1 countable step. Image pane: cell changed, grid held. Text pane: grid changed |
| Memory | TOTAL PSS from meminfo | over 100 MB drift in a phase |
| Flows | Maestro exit code | pairing, soak, navigation, document open or graphics open did not complete |
| Graphics pipeline | host journal `graphics.pipeline` | no event, p95 over 250 ms, or frame bytes p95 over 800 kB |

`adb shell top -H -n 1` is not used anywhere. It reports a thread's lifetime
average, which once made a saturating build and a healthy one measure
identically — 96% against a real 63%. Nothing in-app is used either: once the
JS thread saturates, `console.log` is dropped and the runtime is usually already
dead, so the gate reads only `/proc`, `dumpsys` and `logcat`.

## The load

Fixed profile in `LOAD`, because a smaller herd proves nothing - thirty sessions
is the breadth that starved the phone. The host caps title-only publishes at two
per second per session, so the flood the app must absorb comes from many panes,
not one fast one:

- 30 panes, each changing its terminal title twice a second, every change
  visible in the next snapshot
- 6 of them agent sessions
- terminal streams at 4 kB/s with periodic full repaints, and a full repaint for
  every scroll and resize, which is Herdr's real cost model
- inline Kitty frames at 4 Hz through the host's graphics bridge: a Kitty
  program that repaints on scroll, pane-sized like a phone attach (539x575
  RGBA per frame, ~1.6 MB uncompressed base64) and paced at the ~3 MB/s the
  Herdr app-client socket actually sustains
- cap the producer's frame rate where it offers one, e.g. `TERMINAL_BROWSER_FPS=10`:
  fewer paints before anything hits the socket, and it costs no code

Everything runs in one scratch directory - relay data, machine identity, host
state, Herdr sockets - on ports the kernel picks, and is deleted on exit,
including on Ctrl-C.

## The tour

After the phases, every session the herd serves is opened by deep link and
scrolled hard, with memory sampled after each visit. A leaked terminal, write
pump or decoded image shows up as a rising floor that no single-screen soak can
see. The list comes from the herd, so a bigger world means a longer tour.

## The phases

30 s warmup after the herd screen appears, then the original four sampled
windows plus six scripted gesture phases. Maestro only navigates. Measured
motion is `perf/lib/gestures.mjs`: one `adb shell input swipe` per gesture.
A bout whose median velocity is under 70% of intended is retried once and
then fails as `device could not inject`.

This is a deviation from section 4.2, which asked for `input motionevent` so
a fling could be an ease-out that lifts while still moving. On this emulator
one motionevent costs ~49 ms of round trip (a new shell and JVM per call),
so a ten-step fling takes about half a second whatever `stepMs` says and the
70% guard correctly refuses the numbers. `input swipe` interpolates on-device
at kernel timing: a 120 ms swipe was 177 ms wall here, one spawn of overhead
rather than ten. A fling is therefore a short linear swipe (~800 px in 120 ms,
~6600 px/s) and a drag a long one (~800 px in 700 ms, ~1100 px/s). Evidence
records both the profile name and the achieved rate. `motionevent` stays only
for taps and for a press-hold-then-drag where the hold matters.

The four that were already here: idle on the herd (120 s),
`flows/herdSoak.yaml` (strip and tree scrolling), `flows/herdNavigate.yaml`
(attach an agent's terminal, drag its scrollback, detach, walk the plugin
tabs, leave the app and return), and `flows/graphicsScroll.yaml` (opens a
graphics pane; the gate then scripts `scrollBout` for 90 s). Graphics limits
are `graphicsPipelineP95Ms` 250, `graphicsBytesP95` 800 kB and
`scrollToFrameP95Ms` 400. Superseded frames are reported, not gated.

The six that measure feel:

| Phase | Seconds | Drive |
| --- | --- | --- |
| `herd tree fling` | 30 | `scrollBout` on the herd |
| `herd strip paging` | 20 | `stripBout` (horizontal, y = 33%, 60% of width) |
| `document scroll and swipe` | 30 | `flows/openDocument.yaml`, then 20 s of `scrollBout` and 6 horizontal swipes |
| `terminal text fling` | 30 | tap the first live card, `scrollBout` |
| `graphics pane scroll` | 90 | scripted `scrollBout` after the open-only graphics flow |
| `zoom tap navigate` | 60 | `viewBounds` + `input tap` on `Zoom in` / `Zoom out` / `Reset zoom`, then pane tap / fling / pan |

Every scroll phase also proves the content moved. The gate captures `screencapRaw` of the
scrollable rect before and after the bout and compares mean absolute RGB difference to 8/255
(the same helper the graphics pane uses). The strip additionally requires the first visible
card label to change (or the pixel diff if no label is exposed), the document requires the
first gutter line number to change, and a terminal fling requires `terminal.scroll-rows` > 0,
at least one `terminal.scroll-latency`, and `terminal.scroll-clamped` = 0. A bout that injected
at the intended velocity and moved nothing fails as `content did not move`. Evidence records
both the input (`gestures`, `medianVelocityPxPerSecond`) and the movement it produced.

`--profile emulator|device` selects a second LIMITS object, not a multiplier.
The emulator column is the software-rendered floor (no pathology). The device
column is feel on a 120 Hz phone.

A graphics bridge only opens for a phone that declares cell pixels. This
emulator's software-rendered terminal does not, so a run there prints
`note: no phone declared cell pixels` and leaves the graphics cost unmeasured
rather than failing; a phone that *did* declare them and produced no account is
a hard failure. The account itself is proven end to end by
`node perf/fake-herdr/stack.smoke.mjs`, which drives the real host with a client
that declares them.

The host journal is a 512-event, 256 kB ring. A long run can rotate
`terminal.attach` out of the file by the time the gate would have read it
once at the end. The gate snapshots `diagnostics.json` after pairing and after
every phase and unions events by timestamp, and it cross-checks fake-herdr's
`attach.jsonl`. Evidence records `hostJournal.eventCounts` and
`hostJournal.attachJsonl`.

New fake-Herdr records, paths exposed on `startFakeStack`:

- `attach.jsonl` — every `pane.read` (`pane_id`, `cols`, `rows`, `cellWidthPx`, `cellHeightPx`, `at`)
- `graphics-input.jsonl` — every non-welcome graphics-socket message, with the decoded SGR report
- `input.jsonl` — every `pane.send_keys` / `agent.send_keys`
- `--terminal-bytes-per-second 0` — hold a pane static for a screenshot comparison

New device signals in `androidSignals.mjs`: `resetGfx`, `frameStats` (PROFILEDATA
by header name), `refreshHz`, `deviceMonotonicSeconds`, `screencapRaw` (16-byte
header + RGBA8888), `viewBounds`. `jankReport` takes `hz` and compares histogram
buckets to `round(1000 / hz)`, never a hard-coded 16.

## Thresholds

Healthy after the current fixes: 20-26% JS thread, ~58 fps, memory flat within
20 MB. Failing looked like 96-100%, a dead runtime inside twenty seconds, zero
frames and 90 MB/min of drift. The hard lines sit in that gap, far enough from
both that emulator noise cannot cross them. One run is the gate; there is no
median-of-N because the healthy and failing states are not close.

## Before a release

Record evidence and name it in the release workflow input:

```bash
yarn perf --record docs/perf/<version>.json
```

The JSON carries the commit sha, the load profile, every phase's numbers and the
final screenshot path.
