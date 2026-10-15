# Read a screen title in the sticky header

Stack screens that use the shared sticky header (Settings, Accounts, and
siblings) keep the title on one line inside the row. At 270 dp and font scale
2.0 a short title such as Accounts still reads whole; a title longer than the
row ends in a single-line ellipsis. The back control and any right-side actions
stay fully visible and tappable. Wide screens at font 1.0 look unchanged.

## Sub-features

- `header-title-short` Accounts / Settings at 270 dp font 2.0: title whole, no
  off-screen or mid-glyph clip.
- `header-title-long` a longer stack title (for example Computer collaboration
  or Conversation history) at 270 dp font 2.0: one line ending in `…` when it
  cannot fit; that trailing ellipsis is the intended stress, not a defect.
- `header-title-wide` the same screens at 390 dp font 1.0: title and chrome
  match the pre-change layout.

## How to get to it (user POV)

- Open Settings, then Accounts. Open one more stack screen whose title is
  longer than Accounts (Settings → Computer collaboration, or Conversation
  history from an agent).

## Driving it with the private stack

Preconditions:

- Web export or release APK from this checkout. PWA: serve the export with
  `scripts/diagnostics/application/serveWebExport.mjs` and open it in a
  standalone Chromium `--app=` window. Native: task-owned emulator under
  `flock -o /tmp/fm-muxr-emulator.lock`, every `adb` call with `-s <serial>`.
- Capture Accounts, Settings, and one long-title screen at 270 dp / font 2.0
  in light and dark on the installed PWA; capture Accounts at 270 dp / font
  2.0 on native. Also shoot 390 dp / font 1.0 before/after for the unchanged
  wide layout.
- Pass: `visualCheck` prints `clean` for those cells (or only the long-title
  ellipsis named above). Back stays tappable; nothing runs past the right
  edge.

## Gotchas

- React Navigation's custom header is Android, web, and Mac only; iOS keeps
  the UIKit header, which already ellipsizes.
- On web, `fontScale` stays 1 — the Visual check's 270/2.0 cell is a 135×297
  CSS viewport with device scale 4, not a native font_scale setting.
- Force-stop and relaunch (or reload the PWA) after every size, density, font
  or theme change; a stale header layout survives otherwise.
