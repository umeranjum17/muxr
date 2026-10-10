# Pair a lab PWA from a plain-http origin

The production browser pair screen accepts a pairing link only as the full
`https://…/pair#byokit-link:…` wrapper, so a PWA served from a lab's plain-http
relay is refused by the UI ("Native pairing codes are for phones" / a cut-off
link), and the browser-lab rule forbids seeding the `muxr-secure` IndexedDB by
hand. A lab-only page hook, `window.__MUXR_LAB_PAIR__(link)`, pairs through the
app's own production path instead: `pairOverLink` claims the offer and stores
the Hosted Grant through `pairing/infrastructure/webSecureStore.ts`, and
`pairMachine` makes that machine the active connection — the exact durable state
a real UI pairing leaves. This is the one supported lab path around the
HTTPS-only link shape; both `pwa-badge.md` and `pwa-offline.md` pair this way.

## Sub-features

- `lab-flag` the hook registers only when the build-time flag
  `EXPO_PUBLIC_MUXR_LAB_PAIR=1` is set, so it is dead code in a production
  export (see Gotchas).
- `lab-pair` `window.__MUXR_LAB_PAIR__(link)` accepts a browser link or a bare
  `byokit-link:1:…` token, pairs over the running machine's real link, activates
  the connection, and resolves `{ machineId }`.
- `lab-store` the grant is written by the app's own `storeGrant` (AES-GCM
  wrapped into the `muxr-secure` IndexedDB through `webSecureStore`), never by a
  CDP IndexedDB write.
- `lab-stack` `browserPairLab.mjs` starts a loopback fake-Herdr stack (real
  relay, host and E2EE) and mints a fresh browser link on each `SIGUSR1`.
- `lab-absent` a production export carries no `__MUXR_LAB_PAIR__`,
  `lab.invalid`, or `labBrowserPairing` bytes.

## How to get to it (user POV)

On a real HTTPS relay a person pairs a browser through the pair screen: they
open the `https://…/pair#byokit-link:…` link from `muxr pair --browser` and tap
Pair. In a lab the export is served from a plain-http relay, which the pair
screen refuses, so the lab drives the same app path directly through the hook;
the PWA then shows Home connected to the lab machine exactly as a UI pairing
would. Nothing in the user-visible app changes.

## Driving it with the private stack

Preconditions: build the export with the lab flag so the hook is present
(`EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn build && EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn
web:export`), then confirm it shipped
(`grep -l __MUXR_LAB_PAIR__ apps/mobile/dist/_expo/static/js/web/index-*.js`).
Never point the lab at the owner's relay (8792/8793) or his real Herdr session.

1. Start the lab from the repo root and read its lines:
   `node --input-type=module -e "$(< .agents/skills/verify-muxr/features/browserPairLab.mjs)"`.
   It prints `lab ready: relay port <p>` and `browser link: <url>`. Send the
   process `SIGUSR1` to mint another browser link. Keep it running until the
   pairing finishes; its `pair.sock` stays open so the PWA can complete the
   claim.
2. Serve the very export the hook was built from:
   `MUXR_WEB_EXPORT_DIR="$PWD/apps/mobile/dist" MUXR_WEB_PORT=<free>
   node scripts/diagnostics/application/serveWebExport.mjs` (never 8792).
3. Open the installed-PWA window against that origin:
   `CHROME_DEVTOOLS_AXI_SESSION=<name>
   CHROME_DEVTOOLS_AXI_CHROME_ARGS="--app=http://127.0.0.1:<web>/ --window-size=393,844"
   chrome-devtools-axi pages`, then `selectpage <id>`. Assert
   `matchMedia('(display-mode: standalone)').matches` is `true`,
   `isSecureContext` is `true`, and `typeof window.__MUXR_LAB_PAIR__` is
   `'function'`.
4. Pair: `chrome-devtools-axi eval "(async () => await
   window.__MUXR_LAB_PAIR__(<browser link>))()"`; it resolves
   `{ok:true, result:{machineId:…}}`. Reload (`eval "location.reload()"`) and
   assert Home no longer shows the first-run "Securely pair" screen and reads
   the machine name as connected.
5. Confirm the grant is the app's own, not hand-seeded: in the page,
   `await (async () => { const dbs = await indexedDB.databases(); return dbs.map((d) => d.name); })()`
   lists `muxr-secure`, and a fresh profile with no pairing carries none.

## Gotchas

- Absence from production is proven on the artifact: after
  `yarn web:export` with the flag unset,
  `grep -r __MUXR_LAB_PAIR__ apps/mobile/dist` prints nothing (the flag folds to
  `undefined`, terser drops the guarded block). The 2026-10-10 head measured
  0 hits for `__MUXR_LAB_PAIR__`, `lab.invalid`, and `labBrowserPairing`.
- The hook wraps a bare `byokit-link:1:…` token as
  `https://lab.invalid/pair#…`; byokit reads the offer from the fragment and
  never dials that host — the token's own `ws://…/link/v1/…` URLs carry the
  pairing. An already-`https` link is passed through untouched.
- `muxr-secure` is origin-scoped: pair on the exact origin the PWA is served
  from, or the app reads an empty store.
- One pending pairing per host. `SIGUSR1` releases the previous link before
  minting the next; a browser link lives eight hours.
- The HTTPS-link fix has landed (`decidePairingInput` keeps the wrapper, so web
  pairing accepts an `https://…/pair#…` link). With it, the pair screen also
  pairs a hand-wrapped link; the hook stays the scriptable lab path for a
  plain-http origin and never depends on the pair screen.
