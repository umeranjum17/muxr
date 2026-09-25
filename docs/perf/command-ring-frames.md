# Command ring frames — measured, 2026-09-25

The report was that the command ring drops 11–17% of frames when it opens and
closes. The physical-phone runs counted about 1% late ring frames with the
original burst-based split; that split could miss frames after a long stall.
Idle-terminal redraws also contribute to the reported janky share.

## Surface

Every number here is from the **physical phone**: OnePlus CPH2649, serial
`a4b93ea2`, 1080x2376 at 120 Hz, so each frame has an 8.3 ms budget. None of it
comes from an emulator.

The builds were release, arm64, `APP_ENV=preview`, installed as
`com.trymuxr.app.ringlab` (applicationIdSuffix), signed with a test key, and
connected over `adb reverse` to an isolated lab: its own relay and host, and a
Herdr lab session holding one idle shell pane.

- **A**: `47440f204` as it is.
- **B**: `47440f204` plus `"reanimated": {"staticFeatureFlags": {"ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS": true}}`
  in `apps/mobile/package.json`. `libreanimated.so` was checked in both APKs:
  `false` in A, `true` in B. The installed base.apk hash matched B's.

Method: [`perf/ringJank.sh`](../../perf/ringJank.sh), 20 open/close cycles per
run, tapping the floating control on the device itself every 0.8 s. The script
now attributes framestats frames within 400 ms of the latest input frame to
the ring, including resumed frames after a stall within that window; frames
outside tap windows count as idle. The table below records the original runs,
whose split used 80 ms frame bursts; the original captures are not available
to recalculate those counts.

## Results

| run | gfxinfo frames | gfxinfo janky | p99 | burst-classified ring frames late | burst-classified idle frames late |
|---|---|---|---|---|---|
| A1 | 653 | 27 (4.13%) | 16 ms | 1 / 105 | 4 / 15 |
| A2 | 651 | 31 (4.76%) | 16 ms | 1 / 107 | 5 / 13 |
| B1 | 675 | 29 (4.30%) | 16 ms | 0 / 107 | 6 / 13 |
| B2 | 673 | 29 (4.31%) | 16 ms | 3 / 110 | 4 / 10 |
| idle, no taps, 15 s | 26 | 4 (15.38%) | — | — | 4 / 26 |

- **The measured ring frames were mostly on time.** The original burst-based
  split counted 5 late frames out of 429 ring frames (about 1%); a ring frame
  after a stall over 80 ms may have been counted as idle in those runs.
- **The Reanimated flag changes nothing.** A and B are within run-to-run noise,
  so it was not shipped. The hypothesis behind it (per-frame shadow-tree commits
  on the UI thread) is disproven: late frames spend under 1 ms on the UI thread.
- **Another source of the janky share.** Idle redraws are lone frames with no input, about
  every 600 ms: the terminal's cursor blink. Each one costs about 13–18 ms of
  GPU time, against about 3.5 ms for a ring frame. With nobody touching the
  phone, the idle terminal alone scores **15% janky**, which is the range that
  was reported. Any gfxinfo window taken on the terminal screen includes these
  frames.

A fix, if one is wanted, is in the terminal's idle redraw cost, not in the ring.

## The idle cursor blink, measured and fixed — 2026-09-25

Why one blink costs 13–18 ms of GPU, established on the phone rather than
assumed:

- **Every idle frame is a blink.** With the terminal untouched, 15 s of
  `gfxinfo framestats` holds exactly the blink frames (one per ~600 ms, 25–26
  frames). Setting `animator_duration_scale 0` — the terminal's own blink gate
  is `Settings.Global.ANIMATOR_DURATION_SCALE` — and forcing a re-render once
  drops the same window to **0 frames**: without the blink an idle terminal
  draws nothing at all.
- **A blink re-rendered the whole surface.** The blink ran
  `invalidate()` on the whole terminal view, so every blink re-recorded the
  full grid display list (background fill + every row) to toggle one cell.
  GPU time per blink frame (`GpuCompleted − IssueDrawCommandsStart`) was
  12.2–14.5 ms p50 against 3.2–3.5 ms for ring frames.
- **And the GPU has idled down between blinks.** With the cursor moved to its
  own cell-sized layer (visibility flip, cell-only damage), a blink frame
  still measured 8.6–14.5 ms GPU when it arrived on an idle GPU — but frames
  landing back-to-back with a previous frame cost 2–3.5 ms. Per-frame work was
  no longer the surface; the GPU clock ramp after 600 ms idle dominates any
  once-per-blink frame. No per-blink damage trick avoids those misses.

So the shipped fix stops the idle frames: after 30 s with no input or output
the blink timer stops and the cursor holds **solid and visible**; any terminal
write (input echo or output) restarts the blink. The cursor remains painted
by the terminal view; the cell-sized layer was a measurement experiment, not
the shipped fix. The web terminal (xterm.js) is untouched by the patch.

Before/after on the same phone (CPH2649, a4b93ea2, 120 Hz), same build type
(release, arm64, test-signed `com.trymuxr.app.blinklab`), same scenario, same
method (`perf/ringJank.sh`, 15 s idle windows; GPU ms = `GpuCompleted −
IssueDrawCommandsStart`):

| run | window | frames | janky | idle-frame GPU p50 |
|---|---|---|---|---|
| base-idle1 / base-idle2 | idle 15 s | 25 / 25 | 16.00% / 16.00% | 12.2 / 13.6 ms |
| fix2-idle-active | idle 15 s, first 30 s after output | 25 | 44.00% | 13.9 ms |
| fix2-idle-steady | idle 15 s, after 30 s quiet | **0** | **0.00%** | — |
| base-ring1 / base-ring2 | 20 ring cycles | 105 / 105 late 2 / 0 | 1.00% / 0.83% | ring GPU 3.2 / 3.5 ms |
| fix2-ring1 / fix2-ring2 | 20 ring cycles | 120 / 118 late 1 / 2 | 1.33% / 2.16% | ring GPU 3.4 / 3.5 ms |

- The steady idle terminal renders **zero frames** — the 13–18 ms per-blink
  GPU cost and the ~15% idle janky share are gone, and with them the continuous
  battery/heat drain for a terminal nobody is using.
- While active (any input/output within the last 30 s) the blink still runs at
  600 ms and the cursor is always visible — blinking during use, solid at rest.
- The ring is unchanged: ring-frame late counts and GPU are within run-to-run
  noise of the baseline runs above and the original A/B runs.
- For a measurement APK, add a local, uncommitted `buildTypes.blinklab` block in
  `apps/mobile/android/app/build.gradle`: `initWith release`, `signingConfig signingConfigs.debug`,
  `applicationIdSuffix '.blinklab'`, `matchingFallbacks += 'release'`; remove it afterward.
  Build with `APP_ENV=preview` and the lab's `EXPO_PUBLIC_MUXR_*` connection over `adb reverse`.
