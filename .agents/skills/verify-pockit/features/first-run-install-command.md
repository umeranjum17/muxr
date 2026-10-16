# Native first-run install command wraps whole

The native first-run screen (`FirstRunConnection`, native branch) keeps the
install command one tap away under "More ways & timing": opening it shows
Step 1 "On your computer" with the command from the setup card. The command wraps
onto as many lines as the width and text size need, so every character is on
screen at a 270 dp viewport and at the largest system font scale; it is never
cut off at the right edge or hidden in a sideways scroller. Copy
hands over the exact one-line command.

## Sub-features

- `command-wraps` at 270 dp and font scale 2.0 the whole command is visible, wrapped, inside the screen.
- `command-default` at 393 dp and font scale 1.0 the whole command remains inside the existing setup card.
- `command-copy` one tap on Copy puts the exact single-line command on the clipboard and the button reads Copied.

## How to get to it (user POV)

Install the native app and open it unpaired: the screen shows the connect-link
card first. Open **More ways & timing** below it: the existing Step 1 shows
the command and setup effects disclosure.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` isolation. No relay or host is needed: the
screen is the unpaired app. Build a release APK from the candidate
(`node perf/buildPrApk.mjs <out>` under the gradle lock with
`FM_MEM_JOB_GB=16`), boot a task-owned headless AVD, install, and open the app
fresh (`pm clear` first), then open **More ways & timing**.

1. Set the viewport and text size, then force-stop and reopen the app (open **More ways & timing** again):
   `adb -s $SERIAL shell wm size 1080x2376; wm density 640` (270 dp) or
   `wm density 440` (393 dp at 1080 px wide), and
   `settings put system font_scale 1.0|2.0`; `cmd uimode night yes|no` for theme.
2. `adb -s $SERIAL exec-out screencap -p > $EVIDENCE/firstrun-command-<dp>-<scale>-<theme>.png`.
3. Repro check (fails on the old sideways-scrolling row, passes when wrapped):
   dump `uiautomator`, find the node whose text is the command, and require its
   bounds inside `wm size` width with no `HorizontalScrollView` ancestor.
4. Tap Copy: the button reads Copied and Android 13+ shows its clipboard
   preview chip starting `npm instal…` (`cmd clipboard` is absent on stock
   emulator images, so the chip is the readback).
5. Undo: `wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no`.

## Gotchas

- Both native and PWA reveal the same setup card under More ways & timing (`first-run-browser-steps.md`).
- Android may wrap the package name before its slash (`@trymuxr` / `/cli@latest`); inspect the whole command, not an assumed line count. Copy retains the exact one-line command.
- Expanded setup details can exceed the viewport at large text: scroll the command fully into view before capturing.
- Each `perf/buildPrApk.mjs` out dir mints its own test keystore, so the
  before and after APKs carry different signers and `adb install -r` of one
  over the other is refused. Uninstall first, and stop the run if the install
  fails, or the "after" captures silently show the old app.
- Toggling `font_scale` with the app open can keep a stale layout; force-stop and reopen before each capture.
