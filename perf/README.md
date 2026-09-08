# Release performance gate

For bounded PR review, use [the local emulator smoke gate](PR_GATE.md). It
requires matching APK/native-patch provenance and mounted document, terminal,
graphics and Usage flows. Run it locally from frozen reviewed source and retain
the APK, provenance and full evidence; there is no GitHub emulator job. The longer gate below remains the gesture/soak check.

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

## The development probe (not acceptance)

The release gate is not the inner loop. To look at one surface, prepare a
session once in a pane you own and probe it as many times as you like:

```bash
# pane you leave running: starts the world, pairs once, holds both
node perf/probeSession.mjs --platform android --apk /tmp/muxr-0.1.27-vc127-x86_64.apk

# any other pane: about a minute, one surface, against that session
node perf/surfaceProbe.mjs --session /tmp/muxr-probe-session.json --platform android --surface document
node perf/surfaceProbe.mjs --session /tmp/muxr-probe-session.json --platform android --surface tree
node perf/surfaceProbe.mjs --session /tmp/muxr-probe-session.json --platform android --surface terminal
node perf/surfaceProbe.mjs --session /tmp/muxr-probe-session.json --platform android --surface document \
  --attachments-dir /tmp/probe-shots --seconds 60
```

The probe never builds, installs, pairs, runs the 120-second baselines, soaks or
tours. It validates the descriptor first -- owner alive, same scenario, same
source, same artifact digest, same document fixture on the host -- and reports
`inconclusive` with a reason instead of repairing anything.

Its output is a small evidence envelope: provenance and scenario version,
device and refresh, the actions and their cadence, CPU and memory as named
metrics with units and collectors, fresh movement candidates, and the
before/moving/settled screenshots it wrote under
`~/.muxr/attachments/pane/$HERDR_PANE_ID`. A metric nobody could take is
`unavailable` with a reason, never zero.

**Every probe result carries `"partial": true` and `"acceptance": false`.** It
is a development signal. Release acceptance is one uninterrupted `yarn perf`
run on frozen bytes, and nothing here substitutes for it. Frame accounting is
deliberately absent: the gfxinfo ledger is frozen for acceptance, so the probe
reports CPU and memory as diagnostics and proves behaviour from captures,
movement candidates and host records.

## The scenario contract

`perf/lib/scenario.mjs` is the one definition of the world both platforms
measure: 100 panes, 30 agents, titles at 2 Hz, terminal at 4096 B/s, graphics at
4 Hz, and one document fixture with a fixed payload, digest and served-line
count (222 of 240 generated lines survive the file plugin's 24 KiB read). The
Android gate, the iOS gate and the probe all consume it, so a document number
from one platform means the same thing on the other.

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
| Input-to-first-movement | `/proc/uptime` in the same `adb shell` as the swipe, then first input `framestats` row | p95 120 / 60 ms. A bout with no framestats ring fails as `no framestats frames`, and one whose frames were never input-driven as `no input-driven frame`; neither reduces to a passing zero. A zoom tap is a touch like any other: its own tap-and-settle window is captured the same way and held to the same account, with the declared jank thresholds unchanged |
| Missed vsync | gfxinfo delta per fling | 3 / 1 |
| Accidental owners | phone trail agent-page during a vertical bout | any |
| Content moved | `screencapRaw` of the scrollable rect, mean |Δ| ≥ 8/255; strip card label, document gutter line, terminal trail | injected at intended velocity and the surface did not move |
| Terminal fling | the panel's own surface identity, phone trail `terminal.scroll-rows` / `terminal.scroll-clamped` / `timedOut`, and the bout's gesture-scoped Android framestats | judged as **rendering performance, not input latency**. Terminal history has no host response a repaint can be attributed to, so no scroll-to-write latency is measured or gated. The phase must have stood on a text pane, the phone must have asked for rows, the clamp must have eaten none, no scroll may have timed out, and the viewport must have visibly changed -- or be unchanged because the clamp held it, which is reported as the clamp rather than as content that never moved. Travel is < 40 / 60 rows/s |
| Graphics fling | host `graphics.pipeline` bout-scoped `notchesSent` × 3 | < 9 rows/s |
| Named surface | the panel's own `Zoom out` state, read before the bout | `terminal text fling` and `text zoom tap` must be on a text pane, `graphics pane scroll` and `graphics zoom tap` on a graphics pane; a mismatch, or a surface the probe could not identify, fails the phase before a number is read |
| Zoom | the panel's own `Zoom out` / `Reset zoom` state, and one complete observation window of `cell-metrics.jsonl` geometry for this phase's pane | **Two phases, one per surface**: `text zoom tap` on the text fixture and `graphics zoom tap` on the pinned checkerboard. A single phase had to discover which pane it had landed on and grade itself by that, so whichever surface answered was the only one covered. Guards first, on both: a **control** attach of this phase's own pane, the probed surface matching the one the phase declares, and `Reset zoom` disabled -- the app's own report that the pane is untouched at its default. The window is then fail-closed: geometry is drained and validated to quiet, the cursor is taken **immediately before** the first `Zoom in`, the app's control transition is confirmed, observation continues through a bounded settle, and a valid closing read is taken **before any other action** -- so a re-grid that arrives while a UI state dump is being read is still inside the window. Its baseline may be the grid the pane **attached** with; no prior resize is required, and every `terminal.resize` grid change is recorded whether or not the phone declared cell pixels. Text pane: exactly **one** grid transition in that complete window, onto fewer columns *and* fewer rows; a record repeating the grid before it is a repaint and ignored, and a reversal is a second transition and fails. Graphics pane: **no** grid transition, and the fixture's checkerboard measurably 1.25x larger in the phone's own pixels -- that crop, taken from this phase's pane after its own step, *is* the phase-local graphics frame. No aggregate host `graphics.pipeline` count stands in for delivery; it dated publication rather than this pane's step, and was removed rather than replaced with more telemetry. Either way the second `Zoom in` must be seen to step, and `Zoom out` and `Reset zoom` must return the surface to its default, all of it after the closing read. A JSONL that is missing, unreadable, unparsable or caught half-written is **unavailable**, never an empty series: the phase aborts as inconclusive instead of passing on a silent zero |
| Runtime continuity | sampler `restarts` and `gaps` | any restart, or any sample where the JS thread could not be read |
| Memory | TOTAL PSS from meminfo | over 100 MB drift in a phase. Fewer than two comparable samples, or any missed sample, fails as unmeasured rather than as flat. Across the tour, a pane whose memory never sampled fails: the remaining samples are not the whole tour |
| Completion | phases recorded against `PHASES`, and the exit code | a run that was interrupted, or that did not record every phase, names the phases it did not run and can never print `PASS` |
| Flows | Maestro exit code | pairing, soak, navigation, document open or graphics open did not complete |
| Graphics pipeline | host journal `graphics.pipeline` | no event, p95 over 250 ms, or frame bytes p95 over 800 kB |

`adb shell top -H -n 1` is not used anywhere. It reports a thread's lifetime
average, which once made a saturating build and a healthy one measure
identically — 96% against a real 63%. Nothing in-app is used either: once the
JS thread saturates, `console.log` is dropped and the runtime is usually already
dead, so the gate reads only `/proc`, `dumpsys` and `logcat`.

## The load

Fixed profile in `LOAD`, because a smaller herd proves nothing. The host caps
title-only publishes at two per second per session, so the flood the app must
absorb comes from many panes, not one fast one:

- 100 panes, each changing its terminal title twice a second, every change
  visible in the next snapshot
- 30 of them agent sessions
- terminal streams at 4 kB/s with periodic full repaints, and a full repaint for
  every scroll and resize, which is Herdr's real cost model
- inline Kitty frames at 4 Hz through the host's graphics bridge: a Kitty
  program that repaints on scroll, pane-sized like a phone attach (539x575
  RGBA per frame, ~1.6 MB uncompressed base64) and paced at the ~3 MB/s the
  Herdr app-client socket actually sustains
- cap the producer's frame rate where it offers one, e.g. `TERMINAL_BROWSER_FPS=10`:
  fewer paints before anything hits the socket, and it costs no code

The same 100/30 profile is in `perf/releaseGate.mjs` and `perf/iosReleaseGate.mjs`.
The smaller 30 panes / 6 agents profile belongs to the PR smoke gate in
`perf/prGate.mjs` and is documented in [PR_GATE.md](PR_GATE.md); this section
used to quote it, which understated the release load.

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
tabs, leave the app and return). The graphics pane is established by the gate
itself, by the same label-selected card the terminal phases use, and never
inherited from a previous phase. Graphics limits
are `graphicsPipelineP95Ms` 250 and `graphicsBytesP95` 800 kB. Superseded
frames are reported, not gated.

The seven that measure feel:

| Phase | Seconds | Drive |
| --- | --- | --- |
| `herd tree fling` | 30 | `scrollBout` on the herd |
| `herd strip paging` | 20 | `stripBout` (horizontal, y = 33%, 60% of width) |
| `document scroll` | 30 | `flows/openDocument.yaml`, then 30 s of `scrollBout`. The viewer reached from the herd carries no file navigator, so there is no `File n of m` to move and nothing horizontal to measure |
| `terminal text fling` | 30 | open the **text fixture pane** by identity, assert the surface is a text pane, `scrollBout` |
| `graphics pane scroll` | 90 | open the **pinned checkerboard pane** by identity, assert the surface is a graphics pane, `scrollBout` |
| `text zoom tap` | 60 | open the **text fixture pane** by identity, assert the surface is a text pane, `Show terminal controls`, tap `Zoom in` / `Zoom out` / `Reset zoom`, then pane tap / fling / pan |
| `graphics zoom tap` | 60 | open the **pinned checkerboard pane** by identity, assert the surface is a graphics pane, same tap sequence, and prove the magnification in the pane's own pixels |

The terminal phases are routed by pane identity, never by card order: the fake herd publishes
`fixturePanes.graphics` (its first pane, where the checkerboard producer is pinned for the run)
and `fixturePanes.text` (the first pane with no agent and not the pinned one). An agent pane is
opened through the host's own persisted session binding, a shell pane through its deep link, and
the phase only starts once the host has recorded an attach for that exact pane id since the route
was opened. Because the producer is pinned, a wheel notch on the text pane cannot pull the board
onto it and turn the surface it measures into a graphics one mid-bout.

Every scroll phase also proves the content moved. The gate captures `screencapRaw` of the
scrollable rect before and after the bout -- and, on the graphics pane, once more while the
travel is still one-way, since a bout that flings up and back can end on the picture it started
from -- and compares the largest mean absolute RGB difference to 8/255
(the same helper the graphics pane uses). The strip additionally requires the first visible
card label to change (or the pixel diff if no label is exposed), the document requires the
first gutter line number to change, and a terminal fling requires
`terminal.scroll-rows` > 0 with at least one scroll request, and
`terminal.scroll-clamped` = 0. There is no scroll-to-write latency: a terminal
stream repaints itself whether or not anything was scrolled, so no arriving
frame can be attributed to a particular scroll, and a duration measured against
one that cannot be attributed is not a latency. The phone keeps the in-flight
gate purely as flow control and counts the scrolls that went unanswered inside
the budget (`timedOut`); any of those fails the phase. The phone trail is a
bounded ring, so those counts come from totals it keeps apart from it. A
viewport that did not change is still honest evidence when the clamp is why it
did not: that is reported as the clamp, which is gated at zero on its own,
rather than as content that never moved. A bout that injected
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
control terminal sessions. Evidence records `hostJournal.eventCounts` and
`hostJournal.controlAttaches`.

New fake-Herdr records, paths exposed on `startFakeStack`:

- `attach.jsonl` — every `pane.read` (`pane_id`, `cols`, `rows`, `cellWidthPx`, `cellHeightPx`, `at`).
  Kept as an artifact only: a `pane.read` is a read-only thumbnail of whatever pane the herd screen
  is showing, so it is never attachment proof
- `cell-metrics.jsonl` — the phone's declared geometry per pane and time: `source: terminal.attach`
  carries the `mode` (`control` or `observe`) and the grid the pane opened on -- a usable zoom
  baseline on its own, since a pane the phone never re-gridded still declared a grid -- and is the **only**
  proof that a phase's own pane was really taken over; `source: terminal.resize` adds the cell
  pixels. A phase with no control attach, or no geometry for its own pane, fails as unmeasured
  rather than reading an earlier phase's pane
- `graphics-input.jsonl` — every non-welcome graphics-socket message, with the decoded SGR report
- `input.jsonl` — every `pane.send_keys` / `agent.send_keys`
- `--terminal-bytes-per-second 0` — hold a pane static for a screenshot comparison

New device signals in `androidSignals.mjs`: `resetGfx`, `frameStats` (PROFILEDATA
by header name), `refreshHz`, `deviceMonotonicSeconds`, `screencapRaw` (16-byte
header + RGBA8888), `viewBounds`. `jankReport` takes `hz` and compares histogram
buckets to `round(1000 / hz)`, never a hard-coded 16.

## iOS

`perf/iosReleaseGate.mjs` runs the same load against a retained Release build on
an iOS simulator. `--udid`, `--app` and `--record` are required; the rest are
optional.

```bash
node perf/iosReleaseGate.mjs --udid <UDID> --app /path/muxr.app --record <report.json>
node perf/iosReleaseGate.mjs ... --verify-controls    # control preflight before the clock starts
node perf/iosReleaseGate.mjs ... --start-file PATH     # hold after pairing until PATH appears
node perf/iosReleaseGate.mjs ... --phases soak,navigate,tree,strip,document,graphics,zoom --skip-tour
```

`--verify-controls` drives the strip, an agent, the same agent reopened and a
shell pane after pairing, so a run producing numbers is known to have been driving
real surfaces. `--start-file` holds the run until a named file appears, for
preflight review before the timed window opens. `--phases` selects by drive name
(`idle`, `soak`, `navigate`, `tree`, `strip`, `document`, `graphics`, `terminal`,
`zoom`), refusing unknown or repeated names; with `--skip-tour` it is how a
followup reruns only what a previous attempt could not complete.

Requirements, each a named preflight failure: macOS; `simctl` with a booted
simulator and `xcodebuild`; the `axe` accessibility driver, which with `simctl`
replaces adb and Maestro; an AX root of exactly 402x874 named `muxr`; and the
retained app already running, since the gate attaches rather than installs.

### Deviations from the Android gate

**The app container is preserved, and that is a deviation, not an equivalent.**
Android clears app state with `pm clear`; this runner deliberately keeps the
container so pairing survives, and pairs a fresh isolated host and relay instead.
A fresh host does **not** clear mobile retained state, so anything the app kept
from an earlier run is still there. The gate does verify the container it
attaches to: the installed binary and `main.jsbundle` SHA-256 must match the
`--app` input, or the run refuses to start.

Pairing uses the normal QR v2 consent path: a host-minted short code resolved
through the shared pairing crypto, then the deep-link consent screen and the app
handshake. Manual code entry is not exercised, and `pairingTransport` says so.
The shell target is proved from the control subprocess lifecycle via
`FAKE_HERDR_LOG`, not a thumbnail `pane.read` — a pane that renders is not the
same fact as a shell that ran.

Load and fixtures: 100 panes, 30 agents, the real `plugins` root, a Git fixture
whose tree hash is recorded, and a 2000-line document of which the app renders
the first 240 lines or 24 KiB, larger than the cap on purpose.

### Timing

A full run samples 650 seconds before the tour: a 30 second warmup plus nine
phases totalling 620 (idle 120, soak 120, navigate 120, tree 30, strip 20,
document 30, terminal 30, graphics 90, zoom 60). That is sampled seconds, not
wall time — per-phase setup and in-flight AX overruns are additional, and the
40-pane tour follows and scales with the world.

Setup navigates to the required screen and takes its screenshots **before** the
sampled clock, recorded as `setupSeconds` with `measuredStartedAt` marking where
sampling began. Driving is not bounded by the window: an action in flight when
the window closes keeps running, and the runner waits for it. So `measuredSeconds`
describes the sampler, not the driving. Attribute actions to a window by
timestamps — `startedAt`, `setupSeconds`, `measuredStartedAt`, `finishedAt` — not
by which phase they are listed under.

### Metric limits

Four Android signals have no value on iOS, and the report carries a reason for
each instead of a number:

| Signal | Why it is absent |
| --- | --- |
| `pssKb` | Android proportional-set-size accounting does not exist on iOS |
| `jsBusyPercent` | no validated per-JS-thread CPU sampler for a retained Release binary |
| `fps` | no gfxinfo or SurfaceFlinger equivalent is collected |
| `frameStats` | no instrumented frame timestamps |

RSS is not PSS, and CPU is whole-process — it can exceed 100% and is not JS-thread
utilization. AX command elapsed time is not input-to-frame latency.

Screenshots are captured, but this runner has **no validated automated
content-movement comparison** — nothing in it establishes that a surface moved
the way Android's `screencapRaw` check does. Treat a completed scroll or graphics
phase as evidence the driver ran, not that pixels changed. Whether
identifiable pixels reached the screen is settled by a separate probe, and a
frame count at a write boundary is not the same fact as identifiable colours.

There are no iOS thresholds here, and none should be invented. RSS and CPU from
one run cannot set them: that needs a documented calibration across repeated
healthy and unhealthy runs, the way the Android columns were derived. Nothing in
an iOS report may be compared against an Android limit.

### Evidence and reports

Record a live run into the watched attachments directory, which inside a herdr
pane is the only channel that puts a report or screenshot in front of whoever is
watching. The runner writes its evidence directory beside the record.

```bash
mkdir -p "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID"
node perf/iosReleaseGate.mjs --udid <UDID> --app <path> \
  --record "$HOME/.muxr/attachments/pane/$HERDR_PANE_ID/ios-<version>-<run>-<binary-sha12>.json"
```

Only a sanitized summary is committed, to `perf/results/`. Raw run artefacts stay
out of git: screenshots and logs can capture whatever was on screen or typed, so
they are reviewed before anything is published rather than committed by default.

Name records for the build and the attempt, not the day: several attempts against
one app version on one date are normal, so an explicit run suffix and the app
binary hash are what separate them. A split followup gets its own file naming the
phases it covers, cited alongside the run it supplements, never instead of it.

The current record is [`ios-load-2026-09-07.md`](results/ios-load-2026-09-07.md),
with [`ios-load-2026-09-07.summary.json`](results/ios-load-2026-09-07.summary.json)
for machine-readable detail. Cite the report and quote its own `verdict` —
`COMPLETED_WITH_METRIC_LIMITATIONS`, `FAILED_OBSERVATIONS` or `INCOMPLETE` — rather
than paraphrasing it here, where it would age.

**Coverage across split runs is not a run.** Phases verified in different attempts
do not combine into a completed one. `observedRunComplete` is evaluated per report
and requires `!splitAcceptance`, so a run produced with `--phases` can never claim
the whole gate. Every control and the tour having succeeded somewhere says the
harness can drive each surface; it does not say the app survived one clean run
under load, and only the second would be a gate result.

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
