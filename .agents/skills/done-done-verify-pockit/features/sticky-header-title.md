# Read a screen title in the sticky header

Screens that use the shared sticky header (Settings, Accounts, Home's
"Connect a machine" before a computer is paired, and siblings) keep the title
inside the row. At 270 dp and font scale 2.0 a title that does not fit on one
line wraps to a second and reads whole; only a title longer than two lines ends
in an ellipsis. The back control and any right-side actions stay fully visible
and tappable. Wide screens at font 1.0 look unchanged.

## Sub-features

- `header-title-short` Accounts / Settings at 270 dp font 2.0: title whole, no
  off-screen or mid-glyph clip.
- `header-title-long` a longer title (Home's `Connect a machine` with no
  computer paired, Computer collaboration, Conversation history) at 270 dp
  font 2.0: wraps to two lines, every word whole, no `…`.
- `header-title-wide` the same screens at 390 dp font 1.0: title and chrome
  match the pre-change layout.

## How to get to it (user POV)

- Open Settings, then Accounts. Open one more stack screen whose title is
  longer than Accounts (Settings → Computer collaboration, or Conversation
  history from an agent).
- Fresh install with no computer paired: Home's header reads
  `Connect a machine`.

## Driving it with the private stack

Preconditions:

- Web export or release APK from this checkout. PWA: serve the export with
  `scripts/diagnostics/application/serveWebExport.mjs` and open it in a
  standalone Chromium `--app=` window. Native: task-owned emulator under
  `flock -o /tmp/fm-muxr-emulator.lock`, every `adb` call with `-s <serial>`.
- Capture Accounts, Settings, and one long-title screen at 270 dp / font 2.0
  in light and dark on the installed PWA; capture Accounts and the unpaired
  Home (`home-unpaired-<width>-<font>-<theme>.png`, no stack needed) at 270 dp
  / font 2.0 on native. Also shoot 390 dp / font 1.0 before/after for the unchanged
  wide layout.
- Pass: `visualCheck` prints `clean` for those cells. Back stays tappable;
  nothing runs past the right edge.

## Gotchas

- React Navigation's custom header is Android, web, and Mac only; iOS keeps
  the UIKit header, which already ellipsizes.
- On web, `fontScale` stays 1 — the Visual check's 270/2.0 cell is a 135×297
  CSS viewport with device scale 4, not a native font_scale setting.
- Force-stop and relaunch (or reload the PWA) after every size, density, font
  or theme change; a stale header layout survives otherwise.
