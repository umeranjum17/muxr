# Watch and drive an iOS Simulator from the phone

On a macOS host, an agent pane runs `muxr preview claim <udid>` for a booted
iOS Simulator. The phone then shows a simulator chip on that pane; opening it
streams the simulator live (H.264 from the vendored idb `sim-video`), and taps,
swipes and the Home key drive it through one long-lived idb HID session.

## Sub-features

- `ios-claim` `muxr preview claim <udid>` / `muxr preview release` in a pane;
  a malformed UDID or a missing `HERDR_PANE_ID` fails with exit `1`.
- `ios-chip` the claiming pane (and only it) offers the simulator preview while
  the simulator is booted.
- `ios-stream` the preview goes Live and follows the simulator screen.
- `ios-input` one tap opens an app, one swipe scrolls it, Home returns to
  SpringBoard.
- `ios-shutdown` SIGTERM to the host takes `sim-video`, `idb_companion` and
  `desklink-host` down with it (no PPID-1 leftovers).

## How to get to it (user POV)

- In an agent pane on the Mac: `muxr preview claim <udid>` for a simulator
  the agent booted.
- On the phone, open that pane's terminal; tap the simulator chip; the
  preview opens with a toolbar (Home only: iOS has no keyboard toggle, so a missing keyboard is not a failure).

## Driving it with the private stack

Preconditions:

- A macOS host you may use, holding the Mac slot (one device at a time), with
  a simulator **you created** (`xcrun simctl create fm-… "iPhone 17 Pro"`) and
  booted. Never claim a simulator or device you did not create.
- A private Herdr (its own binary path and `--session`) and a private muxr
  stack (`muxr up` from a task-owned install with its own `MUXR_HOME`), paired
  to an Android viewer (emulator or test phone under its lock).

- **Claim.** In a pane of the private Herdr:
  `MUXR_HOME=<private> node <install>/cli.mjs preview claim <udid>` prints
  `claimed: …`; `$MUXR_HOME/preview/simulators/<pane-id>` holds the UDID.
- **Chip and stream.** Open that pane on the viewer, tap the simulator chip,
  wait for Live; screenshot the viewer next to `xcrun simctl io <udid>
  screenshot` and compare.
- **Input.** Record the viewer (`adb shell screenrecord`) while tapping an app
  icon and swiping its list; the recording shows the app open and scroll.
  Latency: turn on `show_touches` and diff the touch dot frame against the
  first changed simulator frame; record an Android-emulator mirror the same
  way for the baseline.
- **Shutdown.** Note the helper PIDs (`ps -o pid,ppid,command` children of
  the host), `kill -TERM <exact host pid>`, and show they are all gone.
- **Failure path.** `preview claim not-a-udid` exits `1` with the usage line;
  outside a pane it names the missing `HERDR_PANE_ID`.

## Gotchas

- `HERDR_SOCKET_PATH` defaults to the owner's real Herdr: export the private
  socket for the host, or it will list (and attach to) the owner's panes.
- Set `MUXR_RELAY_MDNS=0` and bind the relay to the tailnet IP, so the viewer
  never discovers the owner's own relay on the LAN.
- Call the private install by its explicit path; plain `muxr` on the Mac is
  the owner's installed CLI. Find PIDs from your own `up.mjs` children, never
  by `pgrep host.js` — that matches the owner's host too.
- The companion must run `--only simulator`; without it idb also attaches to
  any USB iPad/iPhone on the Mac.
- The simulator's stream is H.264 High; the host relabels the offer as
  Constrained Baseline because Android WebRTC negotiates High only on
  Qualcomm/Exynos decoders. A black picture or "transport" failure on another
  phone points here.
- The stream is half the panel (`--scale 0.5`, 603x1311 on a 17 Pro); the full
  1206x2622 does not decode on the emulator.
- `scripts/release/pack.mjs` refuses on a stale web export but still rebuilds
  `dist-npm/host.js`; for a lab redeploy copying that one file is enough.
