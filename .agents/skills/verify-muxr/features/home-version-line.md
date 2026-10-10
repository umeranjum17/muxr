# Read a version difference as one quiet Home line

When the phone app and the computer run different muxr versions, Home says so
once, quietly: one line in secondary text at the foot of Home, whole line a tap
to Settings > Connection. It is never a card, never the top slot; the runtime
notice keeps that place.

## Sub-features

- `version-line-quiet` secondary text size and colour, no card, no dot, no
  chevron, at the foot of Home below every section.
- `version-line-action` one plain sentence with the action after a `·`; the
  whole line opens the versions screen.

## How to get to it (user POV)

- Keep the computer on an older muxr than the phone app, pair, open Home,
  scroll to the foot.

## Driving it with the private stack

Preconditions:

- The lab host must report a version the app does not. After `yarn build`,
  write `{"version":"0.1.0"}` to `apps/host/dist/package.json` (build output,
  never tracked): the host walks up from its compiled file to the first real
  manifest, so the fake stack host then announces 0.1.0 against the app's
  release version. This is a lab-only override; it must carry `"type":
  "module"` (a typeless manifest makes Node warn and the host self-checks
  fail) and be deleted before running the suite or packing.
- A release APK per build from `node perf/buildPrApk.mjs <out>` on an owned
  emulator `SERIAL` (as `home-header-name.md`); builds from different code
  install over each other, but `pm clear` between before and after keeps each
  pairing fresh. Pair from `mintPairing()`'s `muxr://pair#<code>` deep link.
- Capture Home at 360dp and at the reference phone (`wm size 1080x2376`,
  `wm density 640`, font scale 1.3) with the composer dock on screen, each
  dark and light, relaunching after every change. Capture the top of Home too,
  so the proof shows the notice is absent from the top slot. At 270dp/font
  1.3, scroll from clear of the dock: a swipe that starts on the dock (the
  bottom ~y>=1660 of the 1080x2376 frame) never reaches the SectionList, so
  start above it or the foot is never reached.
- PWA: `yarn web:export`, serve `apps/mobile/dist`, mint a `browser` offer
  off `<host data>/pair.sock`, pair through `/pair` (as `home-quota-row.md`),
  then capture at 393, 270, 1440 and 1920 wide, dark and light.
- Pass: before build shows the old top-slot card; after build shows one quiet
  line at the foot, never above the first Home section, no clipped or
  overlapped text at 270dp font 1.3, and Settings > Connection still opens
  from the line.

## Gotchas

- The mismatch needs both versions known: a host reporting `0.0.0` or nothing
  is "unknown" and must not raise the line (`knownHostVersion`).
- The override changes the version every dist host reports, so the suite's
  pairing tests refuse to pair against it: write it for the capture run and
  delete it before `yarn run check`.
- The app reads theme and font scale at launch; force-stop and relaunch after
  every `wm`/`uimode` change.
- One pending offer per host: close a native offer's socket before minting a
  browser one.
