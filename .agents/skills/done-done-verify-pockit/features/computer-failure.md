# Read a plain Computer failure

When a computer cannot share its screen, its Computer view explains the failure in product words, keeps Try again, and never renders the engine's raw message.

## Sub-features

- Unmapped opening failures use a plain generic cause and next step.
- Existing consent and no-screen guidance remains intact.
- The opening error notice uses the same product copy as the overlay.
- A short 270dp viewport at font scale 1.3 keeps the full message and retry visible.
- A share the portal granted that never sends a picture (a restored window that has closed) recovers through the portal's picker, or ends in the plain no-picture reason; Try again opens anew, and no grant from a share without a first frame is saved or replayed.
- A screen-sharing portal running without ScreenCast (`xdg-desktop-portal` started before the session exported `XDG_CURRENT_DESKTOP`, so it never bound the desktop's backend) reads "Screen sharing needs a restart" with `systemctl --user restart xdg-desktop-portal` and Copy, not the generic copy. The host log line `desktop open failed after <n> ms: source (…)` keeps the engine's reason.

## How to get to it (user POV)

Pair with the lab computer named Umer. Open a shell pane from Home or Panes, then Pane actions -> Computer. On a computer without a screen-sharing portal, the opening fails; read the message and tap Try again.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. For this native journey use a guarded, non-default Herdr lab instead of the fake host. Start real relay and host directly in lab shell panes, with private MUXR_HOME and HERDR_SOCKET_PATH set to the lab socket. Do not use up/dev/service commands or launch an agent CLI. Use a release APK built from the candidate with the emulator's ABI and a task-owned signer; record its source and hash.

1. Give the lab host a portal of its own (see "Portal without ScreenCast" below); `busctl --address=<lab bus> introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop` must lack the ScreenCast interface. Do not disable or change the owner's portal to manufacture this failure.
2. After the relay/host are ready, acquire the assigned emulator lock. Use a task-owned AVD and explicit `adb -s "$SERIAL"` on every call. Deliver a fresh `muxr://pair#<offer>` from the lab's public `node scripts/cli.mjs pair` using `adb shell am start`; compare the words and approve inside the lab terminal.
3. Drive the real app through Panes -> shell pane -> Pane actions -> Computer. Await the failure message. Confirm plain cause, next step and Try again. Raw portal identifiers must not appear.
4. Capture and inspect before/after screenshots in both system themes. Computer over a terminal intentionally uses a dark ScopedTheme, so identical colors across themes are expected. Label the system mode, not a fabricated light surface.
5. Repeat after `adb shell wm size 1080x2376`, `adb shell wm density 640`, and `adb shell settings put system font_scale 1.3`. Prefer setting geometry and system theme before first launch. A configuration change can recreate the activity; re-enter Computer before capturing.
6. After a theme switch, wait for the first painted frame (at least 0.5–1 second after the failure text appears in a fresh uiautomator dump), then capture. Open every PNG. A populated accessibility tree with a blank screenshot is not visual proof.
7. Record Try again -> failure with native screenrecord. Inspect decoded frames and duration before accepting the recording; a requested duration is not evidence of that duration.
8. Save screenshots, recording, device geometry, APK identity and command results outside the repo. Stop exact owned processes, tear down through the guarded helper, and verify the default-session tripwire. Delete task scratch, not evidence.

## Dead restored share (no picture)

The real portal may not be driven by a lab, so a stdio proxy stands in for it in front of the real engine (`DESKLINK_ENGINE=<proxy>` on the lab host, args `serve`). The proxy answers a portal `session.open` that carries a seeded "closed window" restore token by emitting a rotated `session.restoreToken` and, 10 s later, the engine's own `capture did not start within 10s` `source` error. Any other portal open is "the person picked": forward it to the real engine as an `x11` source on a private Xvfb display (from `scripts/diagnostics/application/withPrivateXvfb.sh`, never a bare `Xvfb`) showing a lab page, and emit a fresh restore token for the returned session. A mode file that makes every portal open fail gives the no-picture case.

1. Seed `<MUXR_HOME>/desktop/portal-restore-token` (dir 700, file 600) with the closed-window token before the host's first open.
2. Computer: the share must recover to the lab page within one capture timeout, with no generic failure. The host log shows the dead grant tried once, then an open without a grant. The grant file holds the new token only after the first frame.
3. Switch the proxy to "every open fails", leave and re-enter Computer: the phone says the computer could not share that window and to pick one again (not the generic "allow screen sharing" copy), and no grant is saved (the dead one was spent on the open).
4. Try again must send a new `session.open` (proxy log) without the failed share's token. Clear the mode, and Try again shows the picture.
5. Before/after: on a build without the fix, the dead token is replayed on every Try again and saved again.

## Portal without ScreenCast

The real engine against the real `xdg-desktop-portal`, on a private session bus the lab owns; nothing reaches the owner's bus, portal or compositor.

`computerPortalLab.mjs` drives all of it natively (steps 1–5 on a task-owned emulator, four cells: 390 dp light and dark, 270 dp at font 1.3 dark and light): `flock -o -w 1800 /tmp/fm-muxr-emulator.lock node .agents/skills/done-done-verify-pockit/features/computerPortalLab.mjs --apk <apk> --evidence <dir> --avd-home <dir>`. Pass `--expect "Couldn't open this computer"` for a build without the fix. The PWA runs the same steps by hand with `browserPairLab.mjs` started under the env of step 3.

1. Private bus with no activatable services, so nothing the owner installed starts on it: a `dbus-daemon --config-file=<lab>/bus.conf --fork --print-pid` whose config has `<type>session</type>`, `<listen>unix:path=<lab>/bus</listen>`, one empty `<servicedir>` of the lab's own, and an allow-all default policy. Keep the socket under `~/.cache/fms/<short>/`.
2. Start the frontend the way the broken desktop had it, without a desktop name: `env -i HOME=<lab> PATH=/usr/bin XDG_RUNTIME_DIR=<lab>/run DBUS_SESSION_BUS_ADDRESS=unix:path=<lab>/bus /usr/lib/xdg-desktop-portal`. Introspection lists no `org.freedesktop.portal.ScreenCast`.
3. Start the lab stack (browser lab or fakeStack) with that bus and a Wayland name that exists nowhere, so the host picks the portal and the engine never meets the owner's compositor: `env -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u XDG_CURRENT_DESKTOP DBUS_SESSION_BUS_ADDRESS=unix:path=<lab>/bus WAYLAND_DISPLAY=wayland-lab …`.
4. Computer: within a second, "Screen sharing needs a restart", the body, the `systemctl --user restart xdg-desktop-portal` command with Copy, and Try again. The lab host log reads ``desktop open failed after <n> ms: source (compositor has no ScreenCast portal: A portal frontend implementing `org.freedesktop.portal.ScreenCast` was not found)``. Before the fix: "Couldn't open this computer" with the generic body, and a log line with the code alone.
5. Restart only the lab frontend (its exact PID) with `XDG_CURRENT_DESKTOP=Hyprland`; Try again now reaches the backend. Without a real backend on the lab bus the open then fails with other words, which is expected.

## Gotchas

- The engine's `source` refusal becomes the client's `platform` failure. Do not substring-match log-only messages or force an unsupported `source` value into SessionSnapshot.
- Changing display density/font/night mode may reopen the last pairing intent. Back out to Home and re-enter the shell's Computer view; do not approve an expired offer.
- A blank capture, a development client, or an overlay test alone cannot prove the release UI. Report missing proof explicitly.
- A pairing offer expires in minutes, and a pending pair-socket request blocks a new offer ("another pairing is in progress"). Approve on the phone at once, or drop the pending request and ask again.
- Never share pairing offers, grants or whole private logs in evidence.
