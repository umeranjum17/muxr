# Show one needs-you count on the app, the favicon and the PWA icon

The Home Needs you list, the Spaces header summary, the browser tab's favicon
dot and the installed PWA's app icon badge all show the same agents, from one
selector (`needsYouSessionIds` in `apps/mobile/sources/herd/domain/herdTree.ts`,
counted through `useNeedsYouCount`, listed by `needsYouActivityRows`; the
per-status rule is `statusNeedsYou`). An Agent counts when its Herdr pane is
`blocked` or `failed`, plus any online session holding a pending request no pane
already covers, counted once per Agent Route. Previously the favicon/badge counted
only online sessions with `agentState.requests`, so a `failed` pane with no
request showed in the app but not on the icon, and a request the pane list
missed showed on the icon but not in the app. An agent leaves the Needs you list
only when it stops needing you, never because its card was seen.

## Sub-features

- The Needs you list has exactly as many rows as the Spaces header's needs-you
  number and the badge, even after the first Live card has been on screen for
  seconds; answering one agent drops the list, the card, the count and the
  badge together. A failure whose agent left the tree (could not start) is not
  in that list: it sits in its own `Failed` tier until opened.

- The Spaces header's needs-you number equals the favicon state (`favicon.svg`
  vs `favicon-active.ico`) and the `navigator.setAppBadge`/`clearAppBadge` value.
- A `failed` pane counts (badge set), with no pending request.
- A `blocked` pane with a pending request counts once, not twice.
- A pending request the agent-based pane count misses (a blocked shell pane)
  counts once.
- Nothing waiting clears all three.

## How to get to it (user POV)

Pair a computer that has an agent waiting on you, open Home. The `Spaces` header
reads `N needs you`; the browser tab (or, installed, the icon) carries the same
number. No agent waiting: the header shows only the agent total and the favicon
dot and badge are gone.

## Driving it with the private stack

The list agreement uses the paired lab PWA of `lab-browser-pairing.md`: start
`browserPairLab.mjs` with `LAB_AGENTS=3` and its stdin on a pipe, then write
`1 blocked`, `2 blocked`, wait ~6 s (the first Live card fully on screen at
393 px), write `3 blocked`, and read the Needs you section's rows, the Spaces
header `aria-label` (`3 agents, 3 needs you`) and the recorded badge calls
(`setAppBadge(3)`): three rows, three, three. Write `1 working` to answer one;
all three drop to two together. Capture light and dark at 393 and 270 px.

The favicon and request cases below use the private fake stack directly:

Preconditions: `yarn build && yarn web:export:selfhost`; or no host at all for
the pure favicon/badge origin. To hold an exact herd, use the private fake stack
(relay serving `apps/mobile/dist`, host over `perf/fake-herdr`) and drive
`perf/fake-herdr`'s lab-only `lab.set_agent_status` RPC to set a pane's Herdr
lifecycle (`idle`/`working`/`blocked`/`done`/`failed`) deterministically. Start
`perf/fake-herdr/server.mjs` with `--title-churn-hz 0` so the 15 s churn does not
overwrite the statuses.

1. Start fake Herdr with no churn: `node perf/fake-herdr/server.mjs --dir <dir>
   --panes 1 --agents 0 --title-churn-hz 0`; its first stdout line names the
   sockets and world.
2. Start the relay (`MUXR_RELAY_PORT=0`, `MUXR_WEB_ROOT=<repo>/apps/mobile/dist`,
   the bound port read from its own `relay listening on …` line) and the host
   (`MUXR_MODE=selfhost`, `HERDR_SOCKET_PATH` at the fake's socket). Write
   `selfhost.json` with the machine identity and relay port as `../SKILL.md`
   Launch does.
3. Seed the herd over the fake Herdr socket: `workspace.create` for each pane,
   `agent.start` for the agent panes, then `lab.set_agent_status` with
   `agent_status: 'failed'` on the failed pane, `'blocked'` on the blocked agent
   pane and `'blocked'` on a shell pane. Close the fake's default workspace
   (`workspace.close`, id `w1`) so the tree names only the demo panes.
4. Pair the browser over the host's owner-only `pair.sock` (browser intent,
   auto-approve), keep the resulting grant, and seed the app's own secure store
   (`muxr-secure` IndexedDB: the grant, `muxr.grants.index`, `muxr.connection.v1`
   and `auth_credentials`) the way a successful browser pairing leaves it.
5. Launch a standalone Chrome (`--app=<origin>/`,
   `matchMedia('(display-mode: standalone)').matches` is `true`) with a pre-boot
   script wrapping `navigator.setAppBadge`/`clearAppBadge`, reload, then set one
   state at a time and, per state, read the Spaces header's `aria-label`
   (`N agents, M needs you`), `link[rel="icon"].href` and the last recorded
   badge call. Capture the screen light and dark at 393 px (and 270 px for the
   narrowest review).

## Gotchas

- `Page.captureScreenshot` draws the page only; the favicon dot lives in the
  browser chrome, so its proof is the recorded `link[rel="icon"].href` swap
  (`/favicon-active.ico` vs `/favicon.svg`), not a pixel in the shot.
- `lab.set_agent_status` is a lab-only method, not a Herdr verb; it forces a
  pane's (and its agent's) lifecycle so a proof never waits on the churn.
- The host updates a pane the phone already knows on its next resnapshot; the
  status RPC emits `pane.updated`, so allow a few seconds before reading a
  state, and set panes one at a time only after the previous state has settled.
- A pending request the herd status does not cover (step 3's blocked shell pane)
  is deliberately not an Agent: the header counts it while the per-card agent
  summaries do not, which is exactly the disagreement this feature removes.
- The app restores the connection from the seeded secure store; a fresh origin
  (port) is the clean way to a one-computer run.
