# Command ring frames — measured, 2026-09-25

The report was that the command ring drops 11–17% of frames when it opens and
closes. Measured on the physical phone, it doesn't: the ring's own frames are
on time. The janky share comes from the idle terminal behind it.

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
run, tapping the floating control on the device itself every 0.8 s.

## Results

| run | gfxinfo frames | gfxinfo janky | p99 | ring frames late (framestats) | idle terminal frames late |
|---|---|---|---|---|---|
| A1 | 653 | 27 (4.13%) | 16 ms | 1 / 105 | 4 / 15 |
| A2 | 651 | 31 (4.76%) | 16 ms | 1 / 107 | 5 / 13 |
| B1 | 675 | 29 (4.30%) | 16 ms | 0 / 107 | 6 / 13 |
| B2 | 673 | 29 (4.31%) | 16 ms | 3 / 110 | 4 / 10 |
| idle, no taps, 15 s | 26 | 4 (15.38%) | — | — | 4 / 26 |

- **The ring is smooth.** Across the four runs, 5 of 429 ring frames missed
  their deadline (about 1%).
- **The Reanimated flag changes nothing.** A and B are within run-to-run noise,
  so it was not shipped. The hypothesis behind it (per-frame shadow-tree commits
  on the UI thread) is disproven: late frames spend under 1 ms on the UI thread.
- **Where the janky share comes from.** It is lone frames with no input, about
  every 600 ms: the terminal's cursor blink. Each one costs about 13–18 ms of
  GPU time, against about 3.5 ms for a ring frame. With nobody touching the
  phone, the idle terminal alone scores **15% janky**, which is the range that
  was reported. Any gfxinfo window taken on the terminal screen includes these
  frames.

A fix, if one is wanted, is in the terminal's idle redraw cost, not in the ring.
