# Read plan limits and what the herd is doing on the Home card

The Home card's first line shows each connected plan's mark, then every limit
as window then share left with a space (`5h 100% left`, `7d 0% left`, `Month 11% left`).
Items never shrink or end in `…`; when the line runs out they wrap between
whole items. The card's quiet second line says what the herd is doing, in one
plain sentence per state -- an agent working, an agent waiting for an answer,
an agent stopped, an agent ready, or nothing running -- and never the machine's
own one-word state (`Healthy`, `Busy`), which read as the agent's and told
nobody whether anything waited on them. Nothing else about the card changes:
same layout, size, colours and position.

## Sub-features

- `quota-order` window first, then value, spaced; `Monthly` reads `Month`.
- `quota-wrap` many limits at font 2.0 / 270dp wrap at item boundaries.
- `herd-working` one agent at work reads `An agent is working. Nothing needed from you.`
- `herd-waiting` an agent holding a request or blocked by an approval reads
  `An agent is waiting for your answer. Open it to reply.`
- `herd-stopped` a failed or unreachable agent reads
  `An agent stopped. Open it to see what happened.`
- `herd-ready` an idle or finished agent reads
  `An agent is ready for your next message.`
- `herd-none` no agents at all reads `No agents are running. Start one below.`
  (a bare shell pane is not an agent).
- `herd-urgency` with several agents, one waiting outranks one at work, and one
  stopped outranks one at work.
- `herd-unloaded` before the host has sent its herd the quiet line is empty: a
  herd that has not arrived is not an empty one.

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
- The herd sentence is driven through `homeHerdSentenceNative.mjs`, which
  starts `herdSentenceLab.mjs` (a loopback-or-adb fake-Herdr stack with one
  agent), pairs the phone, and holds the agent's lifecycle with the lab-only
  `lab.set_agent_status` method (`pane.close` for the empty case):

  ```sh
  flock -o -w 1800 /tmp/fm-muxr-emulator.lock timeout 1800 \
    bash <task>/nativeJourney.sh <out>/app-release.apk <out>/visual/native/candidate
  ```

  It covers the working state at 360, 390, 445 and 270 dp (light and dark) and
  at 270 dp with font 2.0, and every other state at 390 dp light and 270 dp
  font 2.0 dark, and runs `visualCheck.mjs` on each cell.
- PWA: `EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export`, then
  `scripts/diagnostics/application/withPrivateXvfb.sh bash
  .agents/skills/done-done-verify-pockit/features/homeHerdSentencePwaCells.sh
  apps/mobile/dist <out>/visual/pwa/candidate` -- the installed PWA (standalone
  `--app` window) paired through `window.__MUXR_LAB_PAIR__`, the same states and
  cells plus desktop 1280/1440, each read back as text and run through
  `visualCheck.mjs pwa-check`.
- The refresh control still sits at the end of that line and still opens its
  throttle/refresh states.
- Pass: every item reads `window value left` with spaces, no `…` on any item,
  wrapped rows break between items, and the quiet line carries the exact
  sentence for the state the herd is in (and never `Healthy`/`Busy`).
  A `visualCheck` lead fails the cell only when it names the card's own line:
  Home's header (its status sits 2dp under its title), the composer over the
  list and the strip's own refresh control carry leads of their own on main,
  so the native cell keeps them in its `.check.txt` for the self-review
  (`homeVersionLineLab.mjs` does the same). The PWA cells must read `clean` at
  360, 390, 445 and desktop; the 270 dp cells must carry the same leads as a
  `CELL_FILTER='^270'` run against main — `OUT_PREFIX=before-` writes a
  comparison set beside them.

## Gotchas

- Run a before/after pair with `CELL_FILTER`/`OUT_PREFIX` against a main export
  (`git archive origin/main`, or `git checkout origin/main -- <the card's
  paths>` then `yarn web:export`): at 270 dp main already puts the version
  line under the composer and ellipsizes the space's name, so a lead there is
  not this change's.
- A native offer pasted into the web app is refused ("Native pairing codes
  are for phones"), and the web app only accepts the `https://…/pair#` form;
  an `http://` initial URL shows "That isn't a muxr pairing string. Open
  muxr on your computer, or run muxr pair, for a new one."
- One pending offer per host: `mintPairing()` holding `pair.sock` makes a
  browser mint fail with "another pairing is in progress".
- Each window length is one item (`5h×2` groups two 5h limits), so the stress
  case shows four items, not seven.
