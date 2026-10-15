# Install a missing Herdr without a terminal

When the paired computer has no Herdr, the phone's Home says so in one plain
sentence ("Herdr is missing on your computer") and says what to do: open the
muxr app on that computer and choose Install Herdr, or run `muxr doctor` there.
The desktop window offers Install Herdr itself. Once Herdr runs, Home recovers
by itself and lists the agents; nobody restarts anything.

## Sub-features

- `missing-signal` the host's `herdr.tree` reply carries `missing: true` only
  when its Herdr socket is down and no compatible Herdr (0.9.1 or newer)
  resolves: an explicit `HERDR_BIN`, else the binary the service pins, PATH,
  `HERDR_INSTALL_DIR` or `~/.local/bin`, then `/usr/local/bin` (`herdrBin()`).
  A Herdr that is installed but stopped keeps the older "Agent runtime
  unavailable" restart card.
- `phone-card` Home's recovery card titles "Herdr is missing on your computer",
  names the desktop app's Install Herdr, and offers `muxr doctor` with a copy
  button; Settings → Connection reads "Herdr is missing on the computer".
- `desktop-install` the window's Install Herdr runs the published installer,
  starts the server, and returns to the normal window (see
  `linux-desktop-app.md`); a failed install reads one sentence with Try again.
- `recover` the host keeps retrying the socket, so Home drops the card and
  shows the agents on its next tree poll, with no tap.

## How to get to it (user POV)

Pair the phone with the desktop app on a computer that has no Herdr. Home
shows the missing-Herdr card; choose Install Herdr in the desktop window and
watch Home turn into the agent list.

## Driving it with the private stack

Preconditions: the no-Herdr desktop lab from `linux-desktop-app.md` step 5
(PATH farm without `herdr`, task-owned `MUXR_HOME`, relay port 0, Xvfb, lab
installer shim over the helper's named session), and a release APK on a
task-owned emulator paired to that window.

1. Read Home's card at 270dp, font 1.0 and 2.0, light and dark.
2. Install from the window offline, then online; poll the phone with
   `uiautomator dump` until "Herdr is missing" is gone and time it from the
   click.
3. Create a workspace and report an agent through the lab helper
   (`pane report-agent --agent pi --state working`); Home lists it.
4. PWA: pair a lab-flag web export (`lab-browser-pairing.md`) to the same
   window and read the card in the installed-PWA window at 270 wide.
5. Before/after: the origin/main AppImage on the same lab shows Ready to pair
   on the window and "Agent runtime unavailable … muxr daemon restart" on Home.

## Gotchas

- The card needs a host built from this change; an older host never sends
  `missing`, so the phone keeps the restart card.
- The host resolves Herdr through `findHerdrBin()` at every spawn, so a Herdr installed
  into `~/.local/bin` (or `HERDR_INSTALL_DIR`) after the host started is used
  without a restart and without a PATH change.
- At font 2.0 the card's pre-existing Retry connection button ellipsizes.
