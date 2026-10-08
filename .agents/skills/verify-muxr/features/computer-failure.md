# Read a plain Computer failure

When a computer cannot share its screen, its Computer view explains the failure in product words, keeps Try again, and never renders the engine's raw message.

## Sub-features

- Unmapped opening failures use a plain generic cause and next step.
- Existing consent and no-screen guidance remains intact.
- The opening error notice uses the same product copy as the overlay.
- A short 270dp viewport at font scale 1.3 keeps the full message and retry visible.

## How to get to it (user POV)

Pair with the lab computer named Umer. Open a shell pane from Home or Panes, then Pane actions -> Computer. On a computer without a screen-sharing portal, the opening fails; read the message and tap Try again.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. For this native journey use a guarded, non-default Herdr lab instead of the fake host. Start real relay and host directly in lab shell panes, with private MUXR_HOME and HERDR_SOCKET_PATH set to the lab socket. Do not use up/dev/service commands or launch an agent CLI. Use a release APK built from the candidate with the emulator's ABI and a task-owned signer; record its source and hash.

1. On the Linux lab host, `busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop` must lack the ScreenCast interface. Do not disable or change the owner's portal to manufacture this failure.
2. After the relay/host are ready, acquire the assigned emulator lock. Use a task-owned AVD and explicit `adb -s "$SERIAL"` on every call. Deliver a fresh `muxr://pair#<offer>` from the lab's public `node scripts/cli.mjs pair` using `adb shell am start`; compare the words and approve inside the lab terminal.
3. Drive the real app through Panes -> shell pane -> Pane actions -> Computer. Await the failure message. Confirm plain cause, next step and Try again. Raw portal identifiers must not appear.
4. Capture and inspect before/after screenshots in both system themes. Computer over a terminal intentionally uses a dark ScopedTheme, so identical colors across themes are expected. Label the system mode, not a fabricated light surface.
5. Repeat after `adb shell wm size 1080x2376`, `adb shell wm density 640`, and `adb shell settings put system font_scale 1.3`. Prefer setting geometry and system theme before first launch. A configuration change can recreate the activity; re-enter Computer before capturing.
6. After a theme switch, wait for the first painted frame (at least 0.5–1 second after the failure text appears in a fresh uiautomator dump), then capture. Open every PNG. A populated accessibility tree with a blank screenshot is not visual proof.
7. Record Try again -> failure with native screenrecord. Inspect decoded frames and duration before accepting the recording; a requested duration is not evidence of that duration.
8. Save screenshots, recording, device geometry, APK identity and command results outside the repo. Stop exact owned processes, tear down through the guarded helper, and verify the default-session tripwire. Delete task scratch, not evidence.

## Gotchas

- The engine's `source` refusal becomes the client's `platform` failure. Do not substring-match log-only messages or force an unsupported `source` value into SessionSnapshot.
- Changing display density/font/night mode may reopen the last pairing intent. Back out to Home and re-enter the shell's Computer view; do not approve an expired offer.
- A blank capture, a development client, or an overlay test alone cannot prove the release UI. Report missing proof explicitly.
- Never share pairing offers, grants or whole private logs in evidence.
