# Reach every pane menu row on a small phone

The terminal's `Pane actions` menu (⋮) is one scrolling list of rows (Inspect,
then the agent's controls, then View) over a fixed Stop agent / Close pane
row. On a short phone the list holds more than it shows, so while rows lie
below its edge that edge dissolves into the menu's surface and the scroll
indicator flashes when it opens (`FadingScrollView`).

Before the fix, the release APK at 270 dp (1080 x 2376 at density 640), on an
agent in a Herdr lab, cut the list 1.5 dp into the Usage row: it read as ending
on Shared Artifacts, and nothing said that Usage and a dozen more rows sat
below. The release journey tapped Usage there, on its 6 px sliver
(`bounds=[106,2044][1046,2050]`) right above Stop agent, and the tap could miss:
`Usage never opened`.

## Sub-features

- `fade-below` at 270 and 393 dp, font 1.0 and 2.0, dark and light: while the
  list holds rows below its edge the last visible row dissolves into the menu
  surface; scrolled to its end, the fade is gone and Terminal controls sits
  clear of the Stop agent row.
- `usage-reachable` in every cell, scrolling Usage into the list's view and
  tapping it opens the Usage screen.
- `journey-taps-in-view` the release journey (`checkPhoneAttach.mjs`) taps a
  row only once it is inside its scroller's view: a row a scroller carried out
  of view is dragged in first, so the tap never lands on what covers it.

## How to get to it (user POV)

Open an agent on a phone about 270 dp wide, tap ⋮ in the header. The list ends
in a fade above Stop agent; scroll it to Usage and tap it.

## Driving it with the private stack

Native: `paneMenuLab.mjs <release apk> <evidenceDir> <avdHome> [main evidenceDir]` from the repo
root, after `yarn build`, inside the emulator lock (`flock -o -w 3600
/tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh node …`). It boots an
owned emulator, starts the perf fake stack, pairs the release APK through
`muxr://pair#` (`pairPhone`), and per cell shoots `menu-<w>-<font>-<theme>.png` and
`-scrolled.png` through `visualCheck.mjs` (into `<evidenceDir>/native/`), then
scrolls Usage into view, taps it and waits for the Usage screen. Run it on
main's APK first (it records its visual leads), then on the candidate with
main's evidence folder: a lead main's run of the same cell lacks is a defect
(the open menu covers the agent's screen, so most leads are that screen). It
exits 1 on any defect; `steps.json` says what it saw. On main the list's cut
row has no fade.

Installed PWA: export with the lab flag (`lab-browser-pairing.md`), run
`browserPairLab.mjs`, serve the export, open a standalone `--app=…` window
through `chrome-devtools-axi`, pair with `window.__MUXR_LAB_PAIR__`, open
Claude 1, then `paneMenuPwaCells.sh <outDir> <agent url>`. It prints
`Usage opened from the pane menu` per cell and exits 1 otherwise. Its
`pwa-check` leads include every control behind the open menu (`covered
control`, `text over text`) and the lab's `/tmp/muxr-perf-…` folder; diff them
against main's run of the same cell.

Release journey: `done-done run phone-attach` (`release-journey.md`) on an
emulator at 270 dp (`wm size 1080x2376; wm density 640`) reaches Usage.

## Gotchas

- uiautomator clips a row its list cuts to the sliver still shown, and leaves a
  row wholly out of view out of the dump. Judge a row against the bounds of the
  nearest `scrollable="true"` node around it, not against the screen: a row
  touching that edge is cut. A child of a cut row can report inverted bounds
  (`[274,2090][894,2050]`).
- A tap while a list is still moving from a drag only stops it: tap a row once
  it held still across two reads.
- The menu's backdrop (`Close pane actions`) spans the screen, so
  `visualCheck.mjs` reports it under the bars and over every row; the lab drops
  those leads.
- Where the list cuts depends on the agent: the fake stack's agent (with its
  folder line under the header) cuts Shared Artifacts in half at 270 dp 1.0,
  the Herdr lab's cuts 1.5 dp into Usage.
- The PWA at 270 px shows Usage in view (its rows and header are shorter); the
  cut on a row boundary is the native layout's.
- `input swipe` waits for the app to take each event; on a busy emulator the
  down can outlast a short swipe, so no move is sent and the down and up land
  as a tap (the terminal opens its keyboard). The labs drag with `input
  motionevent` DOWN, three MOVEs, UP.
