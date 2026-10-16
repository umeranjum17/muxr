# Pair the phone from the installable desktop app

The Linux desktop app (an AppImage) wraps today's relay and host in one
window: it shows the pairing code, walks the two-word approval, and keeps the
computer available (keep-awake, start at login, tray) so the phone can reach it
without a terminal.

## Sub-features

- One window with six states: Starting…, Ready to pair (QR and code), Waiting
  for approval (the phone's two words), Paired, Needs attention (retry), and
  Already running — a command-line install that manages this computer (Quit
  only) or an orphaned desktop relay (Try again and Quit).
- A computer with no Herdr still starts the relay and host: the window follows the
  relay's and host's own reports and shows Ready to pair only once the host
  prints both `link relay: online` and `pairing: ready` (its pairing socket
  listening); the 30-second stall timer only
  offers Try again. A host that stays quiet for 30 seconds shows Needs attention
  with "taking longer than usual" and Try again, and still flips to Ready to
  pair if it comes up after that.
- A host that crashed or was killed leaves `host/pair.sock` behind. The window
  says "muxr stopped unexpectedly" and stays on it (it never re-dials the dead
  socket); Try again, or a relaunch over the leftover file, goes Starting… →
  Ready to pair with no raw socket error (`ECONNREFUSED`) in between.
- A computer with no Herdr shows one sentence ("muxr runs your agents in Herdr,
  which isn't installed on this computer.") with Install Herdr above the
  pairing offer; the QR stays on screen and pairing never waits for Herdr.
  Install fetches the pinned Herdr release asset through the herdr kit's
  sha256-checked `ensureHerdr` into the user's own folder (where `herdrBin()`
  looks, `~/.local/bin` by default; no root), never running a downloaded
  installer script; it shows Downloading Herdr… then Starting Herdr…, starts
  the server and clears the notice; the host picks Herdr up without a restart.
  A wrong-hash or failed download is refused leaving nothing behind, and reads
  "Couldn't install Herdr. Check this computer's internet connection, then
  press Try again."
- Keep-awake and Start-at-login toggles persist and act immediately; autostart
  writes an XDG autostart entry pointing at the AppImage.
- Closing the window keeps the relay and host running in the tray.

## How to get to it (user POV)

Run the AppImage (or let start-at-login open it); the window opens on Ready to
pair with a QR and a code. Scan it on the phone, confirm the same two words on
both sides, tap Pair on the phone and approve on the computer. The window reads
Paired and the phone lands on Home.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. Run the AppImage with a
task-owned `MUXR_HOME`, a relay port free on the host, and the lab Herdr
session; unset the captain's `HERDR_*` variables and `WAYLAND_DISPLAY`, and run
under a software-GL X display. Pair a task-owned emulator running the release
APK.

1. Launch the AppImage and time launch→`Ready to pair`: record the X display
   at 2 fps with an elapsed-time overlay, or read the window's title over CDP.
   Repeat with Herdr hidden from PATH (a symlink farm of `/usr/bin` minus
   `herdr`, kept outside `/tmp`) and no lab socket: the relay and host still
   come up within a few seconds of the with-Herdr run, and the window shows the
   Herdr notice above the pairing offer (step 5).
2. Read the offer out of the window's QR, render a crisp QR into the emulator's
   camera image, and scan it in the app.
3. Confirm the same two words show on the phone's consent and the window's
   approval card; approve in the window.
4. The window reads Paired and the phone reaches Home with live machine stats;
   send one prompt from the phone and read the agent's reply.
5. No-Herdr install: launch with Herdr hidden, `HERDR_INSTALL_DIR` at a lab
   folder, and `MUXR_HERDR_BINARY_URL`/`MUXR_HERDR_BINARY_SHA256` (the herdr
   kit's own override) at a loopback fixture server that serves a `herdr` shim
   routing every call through the lab helper's named session, with that shim's
   sha256. Read the Herdr notice on the window and the paired phone's Home. Point
   `MUXR_HERDR_BINARY_URL` at an unreachable address to make Install read the
   "Couldn't install Herdr" sentence and Try again; point it back at the fixture,
   choose Try again, and time click→window normal and click→phone Home (≈3 s and
   ≈6 s on 2026-10-12), then report an agent in the lab session and see it on
   Home.
6. Toggle keep-awake and start-at-login and read `settings.json` and the XDG
   autostart file back.
7. Killed host: once Ready to pair shows, `kill -9` the exact host PID (the
   app's child running `apps/host/dist/main.js`) and keep watching the window's
   card text over CDP for 8 s: it must stay on "muxr stopped unexpectedly".
   Then call `window.muxr.retry()` and watch to the QR; separately quit with
   `window.muxr.quit()` (pair.sock stays) and relaunch over it. Poll the card
   text every 50 ms: the old raw `connect ECONNREFUSED …/pair.sock` card lived
   about 3 s, so a coarse poll misses it.

## Gotchas

- The app starts its own relay and host only for state it wrote itself. If
  `selfhost.json` came from the command-line install (local or remote) the
  window reads Already running with Quit only. If the desktop's own relay is
  still alive after a hard kill, the window names the owning process and offers
  Try again and Quit; the app never kills that relay itself. A different
  listener on the relay port makes the host exit so the window reads Needs
  attention — useful for the error state, never for pairing. A `selfhost.json`
  that does not parse is refused (Needs attention) rather than overwritten,
  because it may be a command-line identity.
- An inherited `HERDR_SOCKET_PATH` from an agent pane makes the wrapped host
  fail; unset every `HERDR_*` variable before launching. For the with-Herdr
  timing, set `HERDR_SOCKET_PATH` to the lab session's own socket (from the lab
  helper's `session list --json`), never the default one.
- Without libfuse2 the AppImage cannot mount; extract it once with
  `--appimage-extract` and launch its `muxr` binary, so extraction never lands
  inside the launch→Ready timing.
- Keep the lab `TMPDIR` short. Chromium puts its singleton socket under it, and
  a socket path past the 108-byte limit kills the app at launch with SIGTRAP
  and an empty log (`coredumpctl list` shows it).
- The no-Herdr shim must call the lab helper with
  `FM_HERDR_LAB_FLEET_HOME=$HOME_REAL`, the system `herdr` on PATH and no lab
  `XDG_*`; under the lab HOME the helper's fleet tripwire refuses `provision`
  and the window reads "Herdr is installed but didn't start".
- An extracted AppImage's AppRun does not export `APPDIR`; the window then
  strips the AppImage paths by the app binary's own folder. Read the running
  app's `/proc/<pid>/environ` to see what a Herdr started from it would inherit.
- A live paid-model reply stays unproven where the lab credential is expired; a
  local echo provider proves the round trip, not the model.
