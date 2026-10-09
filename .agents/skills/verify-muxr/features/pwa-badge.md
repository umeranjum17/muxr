# Show the needs-you count on the installed PWA's app icon

The installed web client mirrors the "needs you" count - online agents with a
pending permission request - onto the app icon through the Badging API, the web
twin of the native icon badge. `navigator.setAppBadge(n)` shows the count and
`navigator.clearAppBadge()` removes it; a plain tab, an older browser, or a
desktop with no badge surface lacks the API and gets a silent no-op, never an
error. Native keeps its own `shouldSetBadge` path, untouched.

## Sub-features

- `FaviconPermissionIndicator` reads one "needs you" count from the catalog
  store (online sessions whose `agentState.requests` is non-empty) and drives
  both the favicon and `applyAppBadge(count)`.
- `applyAppBadge` is feature-detected: `count > 0` calls `setAppBadge(count)`,
  `0` calls `clearAppBadge()`, and a missing `setAppBadge` returns without
  throwing.
- The badge is web-only; native never calls it.

## How to get to it (user POV)

Install the web client to the home screen (or open the export in a standalone
window), pair it to a computer, and let an agent ask for permission. The app
icon shows the count; when nothing waits, the badge clears. Nothing appears in
a browser without the Badging API.

## Driving it with the private stack

Preconditions: `yarn build && yarn web:export:selfhost`; start the private stack
per `../SKILL.md` Launch, but serve the export from the owned relay by passing
`MUXR_WEB_ROOT=<repo>/apps/mobile/dist`, and drive a fake Herdr whose agents
churn through `blocked` (`perf/fake-herdr/server.mjs --agents 2 --title-churn-hz 2`)
so the count reaches 2 and falls back to 0. No host, relay or Herdr outside this
run is touched.

1. Pair a headless browser device to the running host over its owner-only
   `pair.sock` with `{"intent":{"kind":"browser","authority":"control","personal":false}}`,
   approve the `{approval}` event with `{"yes":true}`, and keep the
   `pair.complete`/`pair.verified` answer as the stored grant
   (`@byokit/pair`'s `pairWithOffer` + `DeviceLink` do this directly).
2. Launch a standalone Chrome at the relay origin:
   `--app=http://127.0.0.1:<relayPort>/`, a task-owned `--user-data-dir`,
   `--remote-debugging-port=<free>`, and `--window-size=393,844`. Confirm
   `matchMedia('(display-mode: standalone)').matches` is `true`.
3. Before the app boots, add a CDP `Page.addScriptToEvaluateOnNewDocument`
   wrapper that records every `navigator.setAppBadge`/`clearAppBadge` call into
   `window.__badgeCalls`.
4. Seed the browser secure store (`muxr-secure` IndexedDB, AES-GCM wrapped) with
   the grant (`muxr.grant.<machineId>` + `muxr.grants.index`), the connection
   settings (`muxr.connection.v1`), and the credentials (`auth_credentials`),
   then reload. This is the state a real browser pairing leaves behind, so the
   app restores the connection and syncs the fake herd.
5. Read `window.__badgeCalls` while the agents churn. The count runs
   `0 -> 1 -> 2 -> 1 -> 0`, with `setAppBadge(2)` at the blocked peak and a
   trailing `clearAppBadge()` when nothing waits.
6. Capture light and dark of the app screen at 393 px.

## Gotchas

- The Badging API needs a standalone window to show a real icon badge, but the
  calls themselves are recorded in any window; the headless desktop taskbar
  shows no badge, so the recorded calls are the proof.
- The app accepts a browser pairing offer only as `https://…/pair#byokit-link:…`;
  a plain-http lab origin is rejected by the pairing UI. Seeding the secure
  store (step 4) is the documented lab path around that.
- `muxr-secure` is origin-scoped: seed it on the relay origin the PWA is served
  from, or the app reads an empty store.
- Native is untouched: this feature is only the web badge; the native
  `shouldSetBadge` handler stays the source of truth there.
