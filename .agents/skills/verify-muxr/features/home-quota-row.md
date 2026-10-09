# Read plan limits on the Home card

The Home card's first line shows each connected plan's mark, then every limit
as window then share left with a space (`5h 100%`, `7d 0%`, `Month 11%`).
Items never shrink or end in `…`; when the line runs out they wrap between
whole items. The rest of the Right now card is frozen and must look the same.

## Sub-features

- `quota-order` window first, then value, spaced; `Monthly` reads `Month`.
- `quota-wrap` many limits at font 2.0 / 270dp wrap at item boundaries.

## How to get to it (user POV)

- Sign in to Codex (or Claude) on the computer, pair the phone, open Home.

## Driving it with the private stack

Preconditions:

- A release APK per build from `node perf/buildPrApk.mjs <out>` on an owned
  emulator `SERIAL` (as `home-header-name.md`). Two builds signed with
  different test keys cannot `install -r` over each other: uninstall and pair
  again between before and after.
- Plan figures come from a stand-in `codex`: copy `codexQuotaStub.cjs` to
  `<scratch>/bin/codex`, `chmod +x`, and start the lab (a `startFakeStack`
  script like `spacesLab.mjs`) with `PATH=<scratch>/bin:$PATH`,
  `CODEX_HOME=<scratch>/codex-home`, and `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`,
  `ZAI_API_KEY`, `PI_AGENT_DIR` unset. It answers `account/read` and
  `account/rateLimits/read` with 5h 100%, 7d 0%, 30d 11% left;
  `QUOTA_STRESS=1` adds a `Monthly` limit with no length and two named
  limits, enough to wrap at font 2.0.
- Capture Home at the default display (font 1.0) and at the reference phone
  (`wm size 1080x2376`, `wm density 640`) with font scale 1.3 and 2.0, each
  dark and light, relaunching after every change, with and without
  `QUOTA_STRESS`.
- PWA: `yarn web:export`, serve `apps/mobile/dist` with any SPA static server,
  start the lab with `transport: 'loopback'` and no native `mintPairing()`,
  then write `{"intent":{"kind":"browser","authority":"control","personal":false}}`
  to `<host data>/pair.sock` (answer `{"yes":true}` to its approval). Type the
  offer into `/pair` as `https://<any>/pair#byokit-link:…` and press Enter;
  capture at 393 and 270 wide, dark and light.
- Pass: every item reads `window value` with a space, no `…` on any item,
  wrapped rows break between items, and the rest of the card (vitals line,
  refresh control) matches the before build.

## Gotchas

- A native offer pasted into the web app is refused ("Native pairing codes
  are for phones"), and the web app only accepts the `https://…/pair#` form;
  an `http://` initial URL shows "That isn't a muxr pairing string."
- One pending offer per host: `mintPairing()` holding `pair.sock` makes a
  browser mint fail with "another pairing is in progress".
- Each window length is one item (`5h×2` groups two 5h limits), so the stress
  case shows four items, not seven.
