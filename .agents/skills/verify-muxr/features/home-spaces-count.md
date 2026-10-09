# Read a space's agent count whole on Home

Home's Spaces card header shows a space's name, its path chip, and its agent
count. On a narrow phone the count stays whole: the path chip ellipsizes first
and the name second, so `1 agent` and `12 agents` never cut.

## Sub-features

- `spaces-count-whole` at 270dp the count reads whole while the path chip
  ellipsizes.
- `spaces-count-extreme` the longest name and path with a two-digit count keep
  the count whole and the chip's ellipsis visible.

## How to get to it (user POV)

- Pair a computer that has at least one workspace, open Home, read the Spaces
  card's count.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>` on an
  owned emulator `SERIAL`; drive the phone over `perf/lib/fakeStack.mjs` (real
  relay, host and E2EE pairing over a fake Herdr), as `home-header-name.md`.
- Seed a workspace whose label is a long path (the fake stack's default
  workspace already is one) and, for the extreme case, one whose label is a
  long name with twelve `pi` agents. Pair with `mintPairing()` and
  `muxr://pair#<code>`.
- Capture Home at the reference phone (`wm size 1080x2376`, `wm density 640`)
  with font scale 1.3 and 2.0, dark and light, relaunching after each change.
- PWA: `yarn web:export`, serve `apps/mobile/dist` with an SPA static server,
  start the lab with `transport: 'loopback'`, write
  `{"intent":{"kind":"browser","authority":"control","personal":false}}` to
  `<host data>/pair.sock` (answer `{"yes":true}` to its approval), then open
  `/pair?offer=<https://<any>/pair#byokit-link:…>` and press `Pair`. Capture at
  270 and 393 wide, dark and light, before and after side by side.
- Pass: the agent count is whole in every shot; the path chip is ellipsized; the
  name stays readable or ellipsized; nothing overlaps or clips.

## Gotchas

- The web app only accepts the `https://…/pair#` carrier form; a bare
  `byokit-link:1:…` is refused as "Native pairing codes are for phones".
- The browser store is IndexedDB, not localStorage: a fresh origin (port) is
  the clean way to a one-computer header for a before/after pair.
- `expo export` writes a hashed bundle under `apps/mobile/dist`; rebuild and
  reload with a cache-busting query, or the old bundle is served.
