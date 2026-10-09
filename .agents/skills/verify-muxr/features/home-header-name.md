# Read the computer name in the Home header

Home's header names the paired computer on one line. A name too long for the
row ends in an ellipsis; it never breaks inside a word, and the action buttons
beside it keep their size.

## Sub-features

- `home-name-single` one paired computer: plain title.
- `home-name-picker` two or more: the title is the machine picker, name then chevron; the chevron stays visible.

## How to get to it (user POV)

- Pair a computer, open Home, read the header. Pair a second computer to get the picker.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>`
  installed on an owned emulator `SERIAL`. Like `spaces-pinned.md`, this
  drives the phone over `perf/lib/fakeStack.mjs`. Name the lab computer by
  setting `machine.name` in the lab's `<stack.root>/muxr/selfhost.json` after
  `startFakeStack` (as `../SKILL.md` Launch writes it), then open
  `muxr://pair#<code>` from `mintPairing()` with
  `adb -s $SERIAL shell am start` and tap `Pair`.

- Pair a short name (`Umer-test`), then a long one
  (`extreme-workstation-umer`) so the long name shows as the picker.
- After each pairing capture `adb -s $SERIAL exec-out screencap -p` at the
  default display and at the reference phone (`wm size 1080x2376`,
  `wm density 640`) with `settings put system font_scale` 1.3 and 2.0, each in
  light and dark (`cmd uimode night yes|no`). Force-stop and relaunch the app
  after every change.
- Pass: the name sits on one line, whole or ending in `…`; chevron and the
  three header buttons are fully visible; nothing overlaps the status line.

## Gotchas

- The phone shows the name its pairing grant carries, which comes from
  `selfhost.json` (the computer's hostname); `MUXR_MACHINE_NAME` renames only
  the host process and never reaches the header.
- The app reads theme and font scale at launch; relaunch before capturing.
- Pre-grant `android.permission.POST_NOTIFICATIONS` with `pm grant` so the
  notification prompt does not cover Home on every launch.
- Undo the display with `wm size reset`, `wm density reset` and font scale 1.0.
