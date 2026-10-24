# See which versions are running from Home and Settings

The foot of Home always names the running app build and, once the paired
computer reports it, the host: `App 0.2.13 · Host 0.2.13`. When the two differ
the same line adds the plain hint `App and computer versions differ · Review
updates`. It is one quiet line in secondary text, whole line a tap to
Settings > Connection; never a card, never the top slot (the runtime notice
keeps that place). Settings > About > Version carries the same pair line, and
Settings > Connection names the app build on its Installed app row.

A build that is not a stable release says so, from the build's own config
(`extra.app.releaseVersion` and `extra.app.buildVariant`, baked by
`apps/mobile/app.config.js`): a nightly reads `0.2.14-nightly.1.1`, another
pre-release `0.2.14-rc.1 pre-release`, a development build `0.2.13-dev`, a
preview build `0.2.13 preview` (`appBuild()` in
`apps/mobile/sources/utils/versionStatus.ts`).

The other surfaces: `muxr --help` leads with `muxr <version>` (a source
checkout adds `(development checkout)`), and the desktop window's footer names
`muxr <version>` (`-dev` when unpackaged).

## Sub-features

- `version-line-quiet` secondary text size and colour, no card, no dot, no
  chevron, at the foot of Home below every section, in every state.
- `version-line-action` the mismatch hint follows the versions after a `·`;
  the whole line opens the versions screen.
- `version-channel` a nightly, pre-release, development or preview build names
  its channel wherever the app version shows.
- `settings-version-row` Settings > About > Version reads the same pair line.

## How to get to it (user POV)

- Pair, open Home, scroll to the foot. For the hint, keep the computer on an
  older muxr than the phone app. Settings (Home header) > scroll to About.

## Driving it with the private stack

`homeVersionLineLab.mjs <apk> <evidence-dir>` (journey `home-version-line` in
`.done-done.yaml`) runs both states on an owned emulator under the shared
emulator lock: the fake stack on this checkout's version, then announcing
0.2.10; it captures the foot of Home and the Settings Version row at 270 dp
font 2.0 and 393 dp font 1.0, dark and light, and taps the line through to
Settings > Connection. The APK is `node perf/buildPrApk.mjs <out>` (a
production release build, so it reads as stable).

- The older host comes from a lab-only manifest: the journey writes
  `{"version":"0.2.10","type":"module"}` to `apps/host/dist/package.json`
  (build output, never tracked; the host walks up from its compiled file to
  the first manifest) and deletes it when it ends. A typeless manifest makes
  Node warn and the host self-checks fail.
- PWA: `homeVersionLinePwaCells.sh <web export> <out>` (journey
  `home-version-line-pwa`) pairs a standalone `--app` window through
  `__MUXR_LAB_PAIR__` and captures Home's foot and the Settings row at phone
  widths 360/390/445/270, 270 and 393 at font 2.0, and desktop 1280/1440, dark
  and light. Export with `EXPO_PUBLIC_MUXR_LAB_PAIR=1`; add
  `MUXR_RELEASE_VERSION=<version>-nightly.1.1` to prove a channel label (the
  base must equal the package version).
- Pass: the line reads both versions at the foot in every cell, never above
  the first Home section, no clipped or overlapped text at 270 dp font 2.0;
  the hint appears only against the older host; Settings > Connection opens
  from the line.

## Gotchas

- The host half needs a known host version: a host reporting `0.0.0` or
  nothing is "unknown" (`knownHostVersion`), so the line reads `App X` alone
  and never raises the hint.
- The override changes the version every dist host reports, so the suite's
  pairing tests refuse to pair against it: never leave it behind before
  `yarn run check`.
- The app reads theme and font scale at launch; force-stop and relaunch after
  every `wm`/`uimode` change.
- One pending offer per host: close a native offer's socket before minting a
  browser one.
- At 270 dp, scroll from clear of the dock: a swipe that starts on the dock
  (the bottom ~y>=1660 of the 1080x2376 frame) never reaches the list.
