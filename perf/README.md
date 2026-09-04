# Release performance gate

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
yarn perf                                  # build, install, pair, load, measure
yarn perf --apk /tmp/app-release.apk       # measure an APK you already have
yarn perf --record docs/perf/0.1.26.json   # write release evidence
yarn perf --keep-load                      # leave the stack up to poke at it
```

Prerequisites, all checked in preflight with a named failure:

- an Android device or the `muxr_sandbox` emulator on adb
- Maestro (`mise x maestro@cli-2.7.0`)
- `yarn build`, since the gate spawns `apps/relay/dist` and `apps/host/dist`

## What it measures, and why only these signals

| Signal | Source | Hard fail |
| --- | --- | --- |
| JS thread busy | `/proc/<pid>/task/<tid>/stat` deltas for `mqt_v_js` | over 60% in any phase |
| Runtime liveness | the `mqt_v_js` thread exists at the end | gone |
| React update depth | `Maximum update depth exceeded` in logcat | any occurrence |
| Frame liveness | `Total frames rendered` from gfxinfo | no frames for 30 s |
| Memory | TOTAL PSS from meminfo | over 100 MB drift in a phase |
| Flows | Maestro exit code | pairing, soak, navigation or graphics scroll did not complete |
| Graphics pipeline | host journal `graphics.pipeline` | no event, p95 over 250 ms, or frame bytes p95 over 800 kB |

Frame rate and jank are recorded but never gated: under swiftshader they
measure the host, not the app.

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

30 s warmup after the herd screen appears, then four sampled windows:
idle on the herd (120 s), `flows/herdSoak.yaml` (strip and tree scrolling),
`flows/herdNavigate.yaml` (attach an agent's terminal, drag its scrollback,
detach, walk the plugin tabs, leave the app and return), and
`flows/graphicsScroll.yaml` (90 s: open a graphics pane and mix short drags with
flings). Graphics limits are `graphicsPipelineP95Ms` 250, `graphicsBytesP95`
800 kB and `scrollToFrameP95Ms` 400. Superseded frames are reported, not gated:
measured against a real producer the pipeline answers a frame in 6 ms, so a
burst is delivered rather than dropped, and a run that had nothing stale to drop
is the good case.

A graphics bridge only opens for a phone that declares cell pixels. This
emulator's software-rendered terminal does not, so a run there prints
`note: no phone declared cell pixels` and leaves the graphics cost unmeasured
rather than failing; a phone that *did* declare them and produced no account is
a hard failure. The account itself is proven end to end by
`node perf/fake-herdr/stack.smoke.mjs`, which drives the real host with a client
that declares them.

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
