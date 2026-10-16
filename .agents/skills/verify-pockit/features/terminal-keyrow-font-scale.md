# Keep the terminal key row and prompt field inside their rows at large font

The native terminal's key row (ctrl, shift, esc, tab, …) and the composer's
prompt field both keep one height and, for the keys, one glyph size. At Android
font scale 2.0 the key labels grew until the trailing keys ran off the right
edge and the labels overran the fixed row height, and the prompt placeholder
grew far past the rail band. Both are capped so they stay whole and reachable at
the largest text size, and normal font scale is unchanged.

## Sub-features

- `keyrow-label-cap` at font scale 2.0 every key in the row is reachable and its
  label is drawn whole, none cut off at the right edge or by the row height.
- `keyrow-reachable` at font scale 2.0 scrolling the row reaches the trailing
  keys (^C, ^D, Enter and the rest) whole, none clipped at the right edge.
- `prompt-placeholder-cap` at font scale 2.0 the composer's prompt placeholder
  sits inside the rail band and stays legible, not grown past it.
- `keyrow-font-normal` at font scale 1.0 the prompt field renders exactly as
  before (the cap only bites above 1.5).
- `keyrow-fit` at font scale 1.0 every key label is whole and the four arrows
  are on screen without scrolling, at 270 dp and at 393 dp (where the whole
  default row fits).

## How to get to it (user POV)

- Home -> open a workspace's pane (a shell or an agent) -> the key row sits
  directly above the composer, and an empty composer shows its prompt
  placeholder. The key row shows by default; Settings -> Appearance ->
  Terminal -> "Key row" toggles it.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK built from this tree (`node perf/buildPrApk.mjs <out>`,
  or a lab-signed `:app:assembleRelease`) installed on an owned emulator `SERIAL`.
- A private stack where the deep-linked pane is a shell. `perf/lib/fakeStack.mjs`
  starts it with `startFakeStack({ panes: 8, agents: 0, titleChurnHz: 0 })`: the
  default `agents: 4` makes `w1:p1`..`w1:p4` agent panes whose sessions are not
  `shell:`, while `agents: 0` leaves all eight panes shells so the route in
  step 2 resolves. No fixture edit is needed: the row and the placeholder show
  on any shell pane.

1. Launch and pair (the pairing flow or `muxr://pair#<code>` with a `Pair` tap).
2. Open the shell pane by deep link, `muxr:///session/shell%3Aw1%3Ap1` (under
   `agents: 0` this is the fixture's first shell pane).
3. Set the reference phone and the largest text:
   `adb -s $SERIAL shell wm size 1080x2376`,
   `adb -s $SERIAL shell wm density 640`,
   `adb -s $SERIAL shell settings put system font_scale 2.0`,
   then `am force-stop` and reopen the session so the app reads the new scale.
4. `adb -s $SERIAL exec-out screencap -p > $EVIDENCE/keyrow-2.0.png`. Repeat with
   `font_scale 1.0` for the unchanged normal size, and `cmd uimode night yes|no`
   for the dark capture.
5. Pass: at 2.0 the whole key row and the prompt placeholder are inside their
   bands — no key label cut at the right edge, none taller than the row, the
   placeholder not grown past the rail; at 1.0 every label is whole and ctrl
   through the right arrow sit on screen at both 270 and 393 dp (`keyrow-fit`).
6. Reachability at 2.0: the row is wider than the viewport, so scroll it left
   with small swipes inside the row (`adb -s $SERIAL shell input swipe 850
   <rowY> 650 <rowY> 300`) until `^C`, `^D` and `Enter` are all whole on screen,
   and capture that shot plus its `uiautomator` bounds. Every key must be
   reachable this way; if one cannot be, that is a failure, not a pass.
7. Undo the display: `wm size reset`, `wm density reset`,
   `settings put system font_scale 1.0`, `cmd uimode night no`.

## Gotchas

- The reference phone is 1080x2376 at density 640 (a 270 dp viewport). The
  first-run welcome hides its pairing-string route below that fold, so pair at
  a roomier density (e.g. 420) and restore 640 before capturing.
- The key row and the composer both sit in the terminal's chrome; that chrome
  follows the app theme, so capture light and dark even though the terminal
  itself paints dark.
- Toggling `font_scale` while the session is open can leave a stale layout;
  force-stop and reopen the session before each capture.
- The row fits itself to the screen width: key padding gives way first (8 dp
  down to 2 dp), then the labels and icons shrink (to 80%). At font 1.0 the
  default row fits whole at 393 dp, and at 270 dp every key through the right
  arrow is on screen with only paste and hide kb past the edge. Past both floors
  (font 2.0, or a long custom row) the row scrolls, and the cap keeps each label
  at one size so it does not grow taller than the row.
