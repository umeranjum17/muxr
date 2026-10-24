# Install a missing Herdr without a terminal

When the paired computer has no Herdr, the phone's Home says so in one plain
sentence ("Herdr is missing on your computer") and says what to do: open the
muxr app on that computer and choose Install Herdr, or run `muxr doctor` there.
The desktop window offers Install Herdr itself. Once Herdr runs, Home recovers
by itself and lists the agents; nobody restarts anything.

Which step leads depends on how that computer was set up: a computer the
desktop app owns leads with its window's Install Herdr; a command-line
computer leads with the terminal command. The other step stays visible,
second. A Herdr older than muxr supports is not a restart either: Home titles
"Herdr is out of date on your computer" and offers `herdr update`, and the
host log says "Herdr is out of date: muxr needs Herdr 0.9.1 or newer. Run
`herdr update`, then restart Herdr." That covers an old binary and an old
server still running after `herdr update` replaced the binary.

## Sub-features

- `missing-signal` the host's `herdr.tree` reply carries `missing: true` only
  when its Herdr socket is down and no Herdr binary at all resolves: an
explicit `HERDR_BIN`, else the binary the service pins, PATH,
  `HERDR_INSTALL_DIR` or `~/.local/bin`, then `/usr/local/bin` (`herdrBin()`).
  A Herdr that is installed but stopped keeps the older "Agent runtime
  unavailable" restart card.
- `outdated-signal` a Herdr that resolves but reports below the minimum muxr
  supports (0.9.1) rides the same reply as `outdated: true`, never `missing`:
  an explicit `HERDR_BIN` pointing at an old binary counts as outdated rather
  than silently skipped, so the phone cannot fall back to the restart card.
- `old-server-signal` a Herdr server still running at a protocol below the
  one muxr speaks (22) also reads `outdated: true`, even when the binary on
  disk is already current: the kit's ping refuses it (`herdr: protocol
  mismatch`), the host logs the plain out-of-date line once, and keeps
  retrying, so a restart onto the update clears the card with no host restart.
  Before, the host logged only `herdr: protocol mismatch`, stopped retrying,
  and Home showed the generic "Agent runtime unavailable" restart card.
- `recipe-copy` the reply also carries `desktopApp: true` when the desktop app
  spawned that host (`MUXR_DESKTOP_APP=1`). The phone leads with the Install
  Herdr step on a desktop-app computer and with the terminal command on a
  command-line computer (`muxr doctor` when missing; for out of date, "muxr
  needs Herdr 0.9.1 or newer. Run this in a terminal there, then restart
  Herdr:" with `herdr update`); the other step stays visible, second.
- `phone-card` Home's recovery card titles "Herdr is missing on your computer"
  (or "Herdr is out of date on your computer"), leads with the step that fits
  the computer, and offers `muxr doctor` (`herdr update` when out of date)
  with a copy button;
  Settings → Connection reads "Herdr is missing on the computer" (or
  "…is out of date…") with the same install pointer.
- `desktop-install` the window's Install Herdr fetches the pinned Herdr release
  asset through the herdr kit's sha256-checked `ensureHerdr` (never running a
  downloaded installer script), starts the server, and returns to the normal
  window (see `linux-desktop-app.md`); a wrong-hash or failed download is
  refused leaving nothing behind, and reads one sentence with Try again.
- `recover` the host keeps retrying the socket, so Home drops the card and
  shows the agents on its next tree poll, with no tap.

## How to get to it (user POV)

Pair the phone with the desktop app on a computer that has no Herdr. Home
shows the missing-Herdr card; choose Install Herdr in the desktop window and
watch Home turn into the agent list.

## Driving it with the private stack

Preconditions: the no-Herdr desktop lab from `linux-desktop-app.md` step 5
(PATH farm without `herdr`, task-owned `MUXR_HOME`, relay port 0, a Xvfb from `scripts/diagnostics/application/withPrivateXvfb.sh`, a
loopback fixture serving the shim herdr with its sha256), and a release APK on a
task-owned emulator paired to that window. For the outdated and recipe
states without the window, use a real (non-`--fake`) foreground lab host,
private HOME/MUXR_HOME and a port-0 relay. All Herdr calls, including session
queries, go through the task's `--herdr-lab` helper. Pin `HERDR_BIN` to a
lab-only shim that reports `herdr 0.8.5` for `--version` and forwards other
calls through `helper run <named-session>`. Let the host validate that running
session and report `pairing: ready`, then stop only it with
`helper stop <named-session>`: the published kit now reports a disconnected
runtime, and the host reports its old binary. Remove only that lab shim for
the missing case; a farm PATH without another Herdr prevents fallback. Start
the host with `MUXR_DESKTOP_APP=1` for the desktop recipe, unset for CLI.
Before restarting the host, re-provision the same stopped lab through the
helper. Never redirect it to an invented or default socket.

Pair a browser link minted on the host's own `pair.sock` through the pair
screen's HTTPS wrapper (or the lab hook in `lab-browser-pairing.md`). Capture
both recipes and both missing/outdated states on native and installed PWA,
light/dark, including the scrolled end. The follow-up regression matrix is
270dp at font 1.3 and 393dp at font 1.0; use the full Visual check matrix when
layout or styles change.

1. Read Home's card at the matrix above; verify the install lead and the
   alternative step, then scroll until Retry connection and Connection details
   are fully reachable. Run the Visual check driver at rest and at the end.
2. Outdated proof: with the old shim as the only Herdr (or pinned via
   `HERDR_BIN`), Home titles "out of date" and leads with the install —
   never the restart card. A pinned old `HERDR_BIN` is the case that used to
   show the generic "Agent runtime unavailable" card: capture it as the
   before shot.
3. Install from the window offline, then online; poll the phone with
   `uiautomator dump` until "Herdr is missing" is gone and time it from the
   click.
4. Create a workspace and report an agent through the lab helper
   (`pane report-agent --agent pi --state working`); Home lists it.
5. PWA: pair a lab-flag web export (`lab-browser-pairing.md`) to the same
   window and read the card in the installed-PWA window at 270 wide.
6. Before/after: the origin/main AppImage on the same lab shows Ready to pair
   on the window and "Agent runtime unavailable … muxr daemon restart" on Home.

Old server, no window: `homeHerdrOutdatedLab.mjs <apk> <evidenceDir>` (the
`home-herdr-outdated` journey) runs the fake stack with its Herdr answering
protocol 21 while its binary reports 0.9.1, pairs a release APK on an owned
emulator, captures Home at 270 dp font 1.3 and 393 dp font 1.0, dark and
light, at rest and at the end, checks the host log line, then flips the fake
to protocol 22 through its `fake.protocol` method and waits for Home to drop
the card with no tap. Run it once with a host built from origin/main for the
before shot: the generic restart card, and no recovery after the flip.

## Gotchas

- The card needs a host built from this change; an older host never sends
  `missing`, so the phone keeps the restart card. An older host with a pinned
  old `HERDR_BIN` sends neither flag, which is the generic-card defect the
  `outdated` state fixes.
- A lab host started with `HERDR_SESSION` execs a Herdr to reach that named
  session at startup, so removing the shim alone takes the host down before it
  can report `missing` (the exit reads `spawn herdr ENOENT`). Drop the session
  env for the missing case too — a real computer with no Herdr has no session
  gate either — while keeping the farm PATH and `HERDR_BIN` free of Herdr.
- `desktopApp` is true only when the desktop runtime spawned that host. A host
  started any other way on a desktop-app computer (service, terminal) reads
  as command-line, and the phone leads with the terminal command.
- The host resolves Herdr through `findHerdrBin()` at every spawn, so a Herdr installed
  into `~/.local/bin` (or `HERDR_INSTALL_DIR`) after the host started is used
  without a restart and without a PATH change.
- At font 2.0 the card's pre-existing Retry connection button ellipsizes.
