# Pick which computer an agent runs on

Over an agent, the `…` overflow has one **Computers** row (there is no separate
`Computer` row) that opens the **Computers** sheet: **View screen** with the
connected computer's name (only where the desktop view is offered and this phone
controls the pane; it opens the same Computer view the floating ring's Computer
slot does), then one row per paired computer under **Your
computers**, each with a plain state — `Online`, `Asleep`, `Offline`, or
`Not paired` — a check on the one the agent runs on, then **Add a computer**:
**Pair a computer** (opens the add-computer steps) and **Add a cloud computer**. Tapping
another online computer switches the agent's computer after a confirmation, so
the next prompt runs there. The sheet is one list over the app's own pairing
grants; a computer that is not the connected one is checked with a fresh host
request before its row says Online.

## Sub-features

- `states` the connected computer reads `Online • In use` while its link is up and
  `Asleep • In use` when the link drops; another computer reads `Online` when a
  fresh probe answers and `Offline` (with a plain reason) when it does not.
- `switch` tapping an online, not-in-use row asks to confirm, then reconnects the
  app to that computer with its stored pairing; the agent's next prompt runs there
  and the check moves.
- `view-screen` **View screen** closes the sheet and opens the Computer view of
  the connected computer.
- `add` **Pair a computer** opens the add-computer steps; **Add a cloud computer**
  opens the cloud checklist (native) or the phone-app note (PWA).
- `not-paired` a computer the app is connected to but holds no pairing for is
  labelled `Not paired` rather than hidden (defensive; see Gotchas).

## How to get to it (user POV)

Open an agent from Home, tap the `…` in the pane header, then **Computers**. The
sheet lists View screen, every computer this device has paired and the two add
rows, whatever the app theme. Tapping an online computer that is not in use asks to confirm and
switches; offline and asleep rows are not tappable and say why.

## Driving it with the private stack

Preconditions: two lab hosts with distinct machine names. Run one instance per
host in its own UTS namespace from the repo root:

```sh
unshare -Ur --uts -- sh -c "hostname Study-PC; exec node $PWD/.agents/skills/done-done-verify-pockit/features/computersLab.mjs A"
unshare -Ur --uts -- sh -c "hostname Desk-Mac; exec node $PWD/.agents/skills/done-done-verify-pockit/features/computersLab.mjs B"
```

Each prints `host <label> (<name>) ready: relay <port>` and a `pairing link`.
`PAIR_KIND=native` prints a code for the pair screen; the default `browser` prints
a link for the PWA. Send `{"cmd":"stop"}` as one newline-terminated line to the
host's control socket (`printf '{"cmd":"stop"}\n' | nc -U /tmp/muxr-computers-lab-A.sock`),
or type `stop` on its stdin, to stop a host so its row reads Offline (or Asleep
when it is the connected one).

Native (release APK on a task-owned emulator, paired through `/pair`):

1. Pair host A: Home empty state → **Other ways to connect** → **Paste the pairing
   string** → paste A's code → **Pair**; approve the consent. The sheet shows
   `A Online • In use`.
2. Pair host B: **Connect Device** in the command palette (Home also offers
   **Other ways to connect**) → paste B's code → **Pair**. The sheet shows both; B
   becomes the connected one.
3. Switch: tap A's row → **Switch**; the sheet closes and Home reconnects to A.
   Prove the next prompt runs there from the hosts' own diagnostics
   (`/tmp/muxr-perf-*/muxr/host/diagnostics.json`): A's `session.prompt` count rises
   and B's stays flat; switch back and the reverse holds.
4. Offline: `stop` the not-in-use host and reopen the sheet — its row reads
   `Offline • Turn it on and keep muxr running to use it.`
5. Asleep: `stop` the connected host with the sheet open — its row reads
   `Asleep • In use`.

PWA (browser build with the lab flag, over `serveWebExport.mjs`):

1. Build `EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export`, serve `apps/mobile/dist`
   on a private port, open it as an installed window (`--app=… --window-size=393,844`)
   and set the desktop colour scheme to dark so the app matches the phone.
2. Pair both hosts through `window.__MUXR_LAB_PAIR__(<link>)`; each resolves
   `{machineId}` and Home connects to the second.
3. Open an agent → `…` → **Computers**; drive the same switch, Offline and Asleep
   steps above. Capture at 393 and 270 px.

## Gotchas

- The sheet is a dark surface over the session (like the pane overview) and forces
  `ScopedTheme dark` around its own render, so its rows stay dark under either
  app theme even when a later re-render mounts them. On native that scope also does
  not survive the RN modal boundary, so the sheet states its own text colours and
  the switch confirm re-applies the scope. Capture the PWA in both app themes; a
  light app theme must not lighten the sheet.
- `Not paired` is defensive: it appears only for a computer the app is connected
  to that has no stored pairing (a pairing lost on the device while the connection
  persists). Normal pairing always stores a grant, so it is not reachable through
  the pair UI; it is covered by the sheet's row build, not by a pairing journey.
- The connected computer's row comes straight from the app's own link
  (`socketStatus`); every other row waits on a fresh `LinkFirstClient` probe, so a
  slow or dead host shows `Checking…` first, then settles. Reopen the sheet (a new
  `visible`) to re-probe after starting or stopping a host.
- Both lab instances share the real hostname unless run under `unshare --uts`;
  without it the two rows read the same name.
