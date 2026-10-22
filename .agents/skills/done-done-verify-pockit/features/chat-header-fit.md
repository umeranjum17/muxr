# Fit the agent header beside its controls with a long task

The agent screen's header row (chat and terminal view) holds the back, the
title button (status dot, task, name, account chip, changes count, status
word) and then the chat/terminal toggle, the pane count and ⋮. Those controls
never shrink; the title button takes what is left and clips to it
(`useHeaderFit.ts`). The task is the one thing that shrinks; when it would fall
below its floor (72 dp at font 1) the status word goes first (its dot stays),
then the name, then the account chip, and each comes back only when the room it
measured is free again. The changes count is an icon and number below 420 dp of
text width.

Before the fix only the task could shrink, so a Working agent with changes
pushed `Working` and the changes pill out of the title button and under the
toggle and ⋮ (`Workin` cut, the dots over it).

## Sub-features

- `header-controls-whole` at 360 and 390 dp, chat and terminal view, light and
  dark, a Working agent with a long task and three changed files: the toggle,
  pane count and ⋮ are the same pixels as with an idle agent named `Umer`.
- `header-status-dot` with no room the status is its dot; with room (the quiet
  short task in terminal view) the word shows beside it.
- `header-extras-leave` crowded chat at 390 dp: the task keeps its floor and
  ends in an ellipsis; the name leaves before the task is squeezed under it.
- `header-narrow` 270 dp and font 2.0 at 390 dp: the same row, task cut with an
  ellipsis, nothing past the screen edge.

## How to get to it (user POV)

Open an agent that is working on a long task in a folder with uncommitted
changes, on a phone about 360-390 dp wide, in chat or terminal view.

## Driving it with the private stack

`headerFitNativeLab.mjs <apk> <evidenceDir> <avdHome>` from the repo root,
after `yarn build`, inside the emulator lock (`flock -o -w 3600
/tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh node …`). The APK is a
lab-id release (`APP_ENV=development MUXR_APP_ID_BASE=app.muxr.headerfit
MUXR_DEV_APP_ID=app.muxr.headerfit.dev MUXR_DISTRIBUTION=direct` with
`-PmuxrDevelopmentApp=true`); the journey finds the package by `headerfit`. It
runs `chatFakeLab.mjs` over adb and drives it through stdin (`status <state>
<task>`, `changes`), pairs, captures every cell quiet and crowded through
`visualCheck.mjs`, crops the header right of the title button and compares the
two with `magick compare`. It exits 1 on any defect; the title's own ellipsis
on the long task is expected and not one. Run it on main's APK too: there it
reports the crowded row painting over the controls.

Installed PWA: export with the lab flag (`lab-browser-pairing.md`), run
`chatFakeLab.mjs` loopback with its stdin fed from a file (`tail -f cmds |
node …`), `SIGUSR1` for a browser link, serve the export, open a standalone
`--app=… --window-size=390,844` window through `chrome-devtools-axi` with its
own `CHROME_DEVTOOLS_AXI_SESSION`, pair with `window.__MUXR_LAB_PAIR__`, open
Claude 1, then `headerFitPwaCells.sh <outDir>` once quiet (`status done Umer`)
and once crowded (`status working <long task>`, `changes`). Every
`header:` line must read `clean: …`; `pwa-check`'s `clipped text` on the long
task (its ellipsis), `text over text` in the chat's inline Markdown and the
terminal's empty node are not this row.

## Gotchas

- Yoga stops shrinking a text once a sibling hits its `minWidth` and leaves it
  at the full row (an earlier try): the extras leave by measured room instead of
  shrinking against a floor.

- uiautomator clips a node's bounds to its parent, so text spilling out of the
  title button is invisible in the dump; only the pixels show it, hence the
  quiet/crowded crop compare.
- The whole agent screen is in the dark scope, so its light-theme header looks
  the same as dark; the light cells prove only that the theme does not change it.
