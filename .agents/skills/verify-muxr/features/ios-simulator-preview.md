# Watch and drive an iOS Simulator from the phone

On a macOS host, an agent pane runs `muxr preview claim <udid>` for a booted
iOS Simulator. The phone then shows a simulator chip on that pane; opening it
streams the simulator live (H.264 from the vendored idb `sim-video`), and taps,
swipes and the Home key drive it through one long-lived idb HID session.

## Sub-features

- `ios-claim` `muxr preview claim <udid>` / `muxr preview release` in a pane;
  a malformed UDID or a missing `HERDR_PANE_ID` fails with exit `1`.
- `ios-chip` the claiming pane (and only it) offers the simulator preview while
  the simulator is booted, including after agent lifecycle updates and reconnect replay.
- `ios-stream` the preview goes Live and follows the simulator screen.
- `ios-input` one tap opens an app, one swipe scrolls it, Home returns to
  SpringBoard.
- `ios-shutdown` SIGTERM to the host takes `sim-video`, `idb_companion` and
  `desklink-host` down with it (no PPID-1 leftovers).
- `ios-crash` killing the `sim-video` helper by its exact PID mid-stream
  restarts it against the same engine session and the view goes Live again
  (before/after captures plus the host log's `restarting` line).
- `ios-teardown` closing the last viewer takes `sim-video`, `idb_companion`
  and the mirror's `desklink-host` down with it (no helper PIDs remain).

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
  to a viewer: an Android emulator or test phone under its lock, or an iOS
  simulator (below).

- **Claim.** In a pane of the private Herdr:
  `MUXR_HOME=<private> node <install>/cli.mjs preview claim <udid>` prints
  `claimed: …`; `$MUXR_HOME/preview/simulators/<pane-id>` holds the UDID.
- **Chip, lifecycle and stream.** Open that pane on the native viewer and capture
  the chip. Through the guarded lab helper, drive the claiming agent from idle
  to working, blocked and idle; a lab harness can self-report with
  `pane report-agent <pane> --source <lab-source> --agent codex --state <state>
  --seq <increasing-number>`. Capture the chip before and after, and record the
  transition. Reconnect the viewer and check the chip remains. An adjacent
  unclaimed agent must have no simulator chip. Tap the claiming pane's chip,
  wait for Live; screenshot the viewer next to `xcrun simctl io <udid>
  screenshot` and compare the streamed device, not just its toolbar. Repeat
  lifecycle stamping with an owned Android emulator when available: both
  device kinds pass through the same host event-stamping path.
- **Input.** Record the viewer (`adb shell screenrecord`) while tapping an app
  icon and swiping its list; the recording shows the app open and scroll.
  Latency: turn on `show_touches` and diff the touch dot frame against the
  first changed simulator frame; record an Android-emulator mirror the same
  way for the baseline.
- **iOS viewer.** An iPad or iPhone simulator on the same Mac can be the
  viewer: install a Release `iphonesimulator` build, pair it by opening the
  `muxr://pair#…` link with `xcrun simctl openurl`, and record it with
  `xcrun simctl io <viewer> recordVideo`. Tap with `axe tap`, swipe with
  `axe swipe`; a horizontal swipe must move the streamed home screen, not
  pop the agent screen.
- **Shutdown.** Note the helper PIDs (`ps -o pid,ppid,command` children of
  the host), `kill -TERM <exact host pid>`, and show they are all gone.
- **Crash.** With the preview Live, note the exact `sim-video` PID that is a
  child of the host and `kill -KILL` only that PID. The host log must show
  `sim-video exited (…) — restarting (1/3)` and then `sim-video streaming
  again` under a new PID; the viewer returns to Live on its own (allow ~90 s
  on a loaded Mac). Capture the viewer plus `simctl io <udid> screenshot`
  before and after.
- **Teardown.** Close the preview on the viewer (Back, never kill the app —
  killing it wedges the engine until the host restarts) and show no
  `sim-video`, `idb_companion` or mirror `desklink-host` child of the host
  remains. Never stop processes by name or pattern; use only exact PIDs this
  run started.
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
- One viewer per simulator: a second device shows "Can't show the simulator
  from here" until the first closes its view, then "Try again" goes Live.
- A portrait device on a portrait viewer opens filled (cropped to its top);
  the actions menu's Fit to screen shows all of it.
- Rotate a simulator viewer with `XCUIDevice.shared.orientation` from a tiny
  XCUITest runner (no assistive access needed). After a rotation `axe`
  touches no longer land where `axe describe-ui` says, so drive a rotated
  viewer from the same runner, by coordinates relative to the live view
  element, and take screenshots with `simctl io` (`axe screenshot` can
  return a stale frame).
- `scripts/release/pack.mjs` refuses on a stale web export but still rebuilds
  `dist-npm/host.js`; for a lab redeploy copying that one file is enough.
- A lab host under a disposable HOME must still reach CoreSimulator's device
  set: symlink the real `~/Library/Developer` into the disposable home, or
  `sim-video` finds no simulator.
- Keep `MUXR_DATA_DIR` under `MUXR_HOME` (the installed shape), so the state
  root is `MUXR_HOME` and `preview claim` writes where the watcher reads.
- The host's Herdr kit speaks one pinned protocol: run the matching `herdr`
  binary for the lab server (0.9.1 for this branch), private to the lab, and
  put it first on the lab PATH.
- `simctl io screenshot` can return a stale frame; the accessibility tree and
  the host log are the primary proof, captures supporting.
- Close the preview with Back, never by killing the viewer app: killing it
  wedges the engine until the host restarts.
