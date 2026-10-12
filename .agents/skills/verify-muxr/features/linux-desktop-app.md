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
- A computer with no Herdr still reaches Ready to pair: the window follows the
  host's own `link relay: online` report, not a timer. A host that stays quiet
  for a minute shows Needs attention with "taking longer than usual" and Try
  again, and still flips to Ready to pair if it comes up after that.
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

1. Launch the AppImage and read the window's title over CDP until it says
   `Ready to pair`. Record launch→Ready seconds. Repeat with Herdr hidden from
   PATH (a symlink farm of `/usr/bin` minus `herdr`, kept outside `/tmp`) and
   no lab socket: it must still reach Ready to pair, within a few seconds of
   the with-Herdr run.
2. Read the offer out of the window's QR, render a crisp QR into the emulator's
   camera image, and scan it in the app.
3. Confirm the same two words show on the phone's consent and the window's
   approval card; approve in the window.
4. The window reads Paired and the phone reaches Home with live machine stats;
   send one prompt from the phone and read the agent's reply.
5. Toggle keep-awake and start-at-login and read `settings.json` and the XDG
   autostart file back.

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
  fail; unset every `HERDR_*` variable before launching. For the with-Herdr timing, set
  `HERDR_SOCKET_PATH` to the lab session's own socket (from the lab helper's
  `session list --json`), never the default one.
- Without libfuse2 the AppImage cannot mount; extract it once with
  `--appimage-extract` and launch its `muxr` binary, so extraction never lands
  inside the launch→Ready timing.
- The window paints late under software GL, so Starting… is only visible
  through the renderer (CDP), not the root capture.
- A live paid-model reply stays unproven where the lab credential is expired; a
  local echo provider proves the round trip, not the model.
