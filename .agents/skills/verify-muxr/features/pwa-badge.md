# Show the needs-you count on the installed PWA's app icon

The installed web client mirrors the "needs you" count onto the app icon
through the Badging API, the web twin of the native icon badge.
`navigator.setAppBadge(n)` shows the count and `navigator.clearAppBadge()`
removes it; a plain tab, an older browser, or a desktop with no badge surface
lacks the API and gets a silent no-op, never an error. The same count the
in-app Spaces summary reads drives the favicon and the badge, so all three
agree. Native keeps its own `shouldSetBadge` path, untouched.

## Sub-features

- `FaviconPermissionIndicator` reads the one `useNeedsYouCount()` selector (an
  Agent Route whose Herdr pane is `blocked` or `failed`, plus a pending request
  no pane already covers) and drives both the favicon and
  `applyAppBadge(count)`.
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

Preconditions: build the lab export with the hook present
(`EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn build && EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn
web:export`) and pair the PWA to the lab machine as `lab-browser-pairing.md`
describes (the plain-http lab pairs through the hook; on a real https relay the
pair screen pairs too). Serve `apps/mobile/dist` with `serveWebExport.mjs` and
drive a standalone Chromium (`--app=…`, task-owned `--user-data-dir`) at 393 px.
`browserPairLab.mjs` starts with `titleChurnHz: 0` — no automatic status churn —
so the proof drives the two agents itself. No host, relay or Herdr outside this
run is touched.

1. Record the badge calls from the page before anything else can ring them:
   `chrome-devtools-axi eval "(() => { window.__badgeCalls = []; const wrap =
   (n) => { const o = navigator[n] && navigator[n].bind(navigator); if (!o)
   return; navigator[n] = (...a) => { window.__badgeCalls.push([Date.now(), n,
   ...a]); return o(...a); }; }; wrap('setAppBadge'); wrap('clearAppBadge'); })()"`.
   `navigator.setAppBadge` is a function in Chromium, so the wrapper installs.
2. Drive the count through one exact cycle: send the lab `SIGUSR2`; it blocks the
   first agent, then the second, then idles the first, then the second, through
   the fake Herdr's `lab.set_agent_status`, holding count 2 for 30 s. A `blocked`
   pane counts as needs-you (`needsYouCount`). Wait the full drive (~41 s) and
   read `window.__badgeCalls`.
3. Assert the recorded sequence is the count running `0 → 1 → 2 → 1 → 0`: the
   calls are `setAppBadge(1)`, `setAppBadge(2)`, `setAppBadge(1)`,
   `clearAppBadge()`. The last clear is `clearAppBadge()`, not `setAppBadge(0)`.
4. Capture the app screen at 393 px, light and dark, at the count-2 hold: send
   `SIGUSR2` again, and for each theme `emulate --viewport
   "393x844x2,mobile,touch" --color-scheme <theme>`, wait ~8 s for the app to
   re-sync after the emulate reload, then `screenshot <path> --full-page`. The
   Spaces header reads `2 agents •2` and the "Needs you" section lists both
   agents — the same number the recorded `setAppBadge(2)` carried.

## Gotchas

- The Badging API needs a standalone window to show a real icon badge, but the
  calls themselves are recorded in any window; the headless desktop taskbar
  shows no badge, so the recorded calls are the proof. `--app=` reports
  `display-mode: standalone`; an ordinary tab does not.
- The page hook (`window.__MUXR_LAB_PAIR__`) is what pairs the plain-http lab
  PWA; see `lab-browser-pairing.md`. Do not seed the `muxr-secure` IndexedDB by
  hand — the hook stores the grant through the app's own `webSecureStore`.
- `muxr-secure` is origin-scoped: pair on the relay origin the PWA is served
  from, or the app reads an empty store.
- The count is the one shared definition: a pane whose Herdr status is
  `blocked` or `failed`, plus a pending request no pane already covers. A
  blocked pane with no pending request counts once, never twice.
- Native is untouched: this feature is only the web badge; the native
  `shouldSetBadge` handler stays the source of truth there.
