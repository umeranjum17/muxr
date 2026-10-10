# Keep terminal tab chip labels inside their row

The native terminal's pane-tabs row above the composer is one fixed height. At
Android font scale 2.0 a tab chip's label grew past that height and its
descenders (`g`, `p`, `y`) were cut off by the row's clip. The label is capped
so it stays whole at the largest text sizes, and normal font scale is unchanged.

## Sub-features

- `chip-label-cap` at font scale 2.0 a tab chip label shows its descenders in
  full, clear of the row's bottom edge.
- `chip-label-normal` at font scale 1.0 the chip label renders exactly as before.

## How to get to it (user POV)

- Home -> a workspace with more than one tab -> open a pane -> read the
  pane-tabs row above the composer. With one tab, turn on Terminal settings ->
  Pane tabs to always show the row.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK built from this tree (`node perf/buildPrApk.mjs <out>`,
  or a lab-signed `:app:assembleRelease`) installed on an owned emulator `SERIAL`.
- A private stack with at least two tabs, one carrying a label with a descender.
  `perf/lib/fakeStack.mjs` (`startFakeStack`) seeds tabs `main`/`review`; none
  has a descender, so rename one through the user path: long-press the chip ->
  Rename -> a word such as `paging`. (Seeding the world's tab labels with a
  descender word works too, but the app-rename path needs no fixture change.)

1. Launch and pair (the pairing flow or `muxr://pair#<code>` with a `Pair` tap).
2. Open a shell pane by deep link, `muxr:///session/shell%3Aw1%3Ap1`.
3. Set the reference phone and the largest text:
   `adb -s $SERIAL shell wm size 1080x2376`,
   `adb -s $SERIAL shell wm density 640`,
   `adb -s $SERIAL shell settings put system font_scale 2.0`,
   then `am force-stop` and reopen the session so the app reads the new scale.
4. `adb -s $SERIAL exec-out screencap -p > $EVIDENCE/chip-2.0.png`. Repeat with
   `font_scale 1.0` for the unchanged normal size, and `cmd uimode night yes|no`
   for the dark capture.
5. Pass: at 2.0 the label's ink clears the row's bottom edge (descenders whole);
   at 1.0 the label is pixel-identical to the same build before the cap
   (the cap only bites above 1.5).
6. Undo the display: `wm size reset`, `wm density reset`,
   `settings put system font_scale 1.0`, `cmd uimode night no`.

## Gotchas

- The reference phone is 1080x2376 at density 640 (a 270 dp viewport). The
  first-run welcome hides its pairing-string route below that fold, so pair at
  a roomier density (e.g. 420) and restore 640 before capturing.
- The terminal paints dark whatever the app theme, so the chip row looks the
  same in light and dark; capture both anyway, since the row sits in app chrome
  that does follow the theme.
- A clip is only visible on a label that carries a descender; a label such as
  `main` shows nothing at 2.0 because it has no descender to cut.
