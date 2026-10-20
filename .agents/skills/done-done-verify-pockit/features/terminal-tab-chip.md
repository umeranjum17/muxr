# Keep terminal tab and notice chip labels inside their row

The native terminal's pane-tabs row above the composer is one fixed height. At
Android font scale 2.0 a tab chip's label grew past that height and its
descenders (`g`, `p`, `y`) were cut off by the row's clip. The notice chip that
shares the row (a gesture hint such as `No other working or recently finished
agent`, `Prompt queued`, `Reconnecting…` and the other connection words) did
the same, and grew wide enough to squeeze the `main` tab to a sliver. Both
labels are capped at 1.5x so they stay whole at the largest text sizes, and
normal font scale is unchanged.

## Sub-features

- `chip-label-cap` at font scale 2.0 a tab chip label shows its descenders in
  full, clear of the row's bottom edge.
- `chip-label-normal` at font scale 1.0 the chip label renders exactly as before.
- `notice-chip-cap` at font scale 2.0 the notice chip's words keep their
  descenders inside the chip at 270 and 393 dp; a long hint ellipsizes on one
  line, by design, and the tab beside it keeps its label.
- `notice-chip-normal` at font scale 1.0 the notice chip renders exactly as before.

## How to get to it (user POV)

- Home -> a workspace with more than one tab -> open a pane -> read the
  pane-tabs row above the composer. With one tab, turn on Settings -> Appearance
  -> Terminal -> Tabs row to always show the row.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK built from this tree (`node perf/buildPrApk.mjs <out>`,
  or a lab-signed `:app:assembleRelease`) installed on an owned emulator `SERIAL`.
- A private stack with every pane a shell and at least one tab carrying a
  descender. `perf/lib/fakeStack.mjs` starts it with
  `startFakeStack({ panes: 8, agents: 0, titleChurnHz: 0 })`: the default
  `agents: 4` makes `w1:p1`..`w1:p4` agent panes, whose sessions are not
  `shell:`, while `agents: 0` leaves all eight panes shells so the route in
  step 2 resolves. It builds its tabs from `TAB_LABELS` in
  `perf/fake-herdr/world.mjs` (`['main', 'review', 'shell', 'scratch']`); none
  has a descender, so set the first entries to descender words (e.g.
  `['paging', 'playing', 'shell', 'scratch']`) before starting. The fake Herdr
  has no rename method, so a long-press Rename in the app fails with
  `method_not_found` and never reaches such a label; seeding the world is the
  only in-stack route. Revert the fixture edit before running the suite.

1. Launch and pair (the pairing flow or `muxr://pair#<code>` with a `Pair` tap).
2. Open a shell pane by deep link, `muxr:///session/shell%3Aw1%3Ap1` (a shell
   under `agents: 0`, in the `paging` tab).
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
5a. Notice chip, same cells: the gesture hint comes from a sideways swipe on
   the terminal with no other agent to reach (`input swipe 950 <y> 150 <y> 120`,
   more than 24 dp in from either edge); it lasts 1.4 s, so `visualCheck.mjs`'s
   screenshot holds it but its later dump usually does not. A status notice
   comes from stopping the relay under the open pane: run
   `terminalReconnectLab.mjs` (terminal-reconnect.md) as the stack, send it
   `open` and then `relay 25`, and capture about 7 s later while `Reconnecting…`
   shows. `Prompt queued` needs a real agent start (home-composer-first-prompt.md)
   and draws through the same label, so the two above stand for it.
   The installed PWA draws these chips at the page zoom (react-native-web pins
   `fontScale` to 1 and ignores the cap), so capture it as `../SKILL.md`'s
   Visual check says and expect it unchanged. A raw CDP
   `Input.dispatchTouchEvent` swipe drives the hint there; chrome-devtools-axi
   has no touch drag, and a mouse drag is text selection, not a page turn.
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
