# Switch panes from the pane switcher

The agent screen's pane counter (`1/4`) or its title opens the pane switcher,
`apps/mobile/sources/herd/presentation/PaneOverviewSheet.tsx`: one full-height
`OptionSheet` (`fill`) that covers the session up to the status bar. Its first
row is the workspace's name with Spaces and Done; under it the workspace's tabs
scroll in a lane of their own; under that the viewed tab's panes are cards, two
across (one below a 300 dp grid), each a live `TerminalPreview` of the pane's
screen over its glyph, title and task line, with × to close. The pane open here
is outlined. The last card is New pane, with Right and Below acting on the
outlined pane.

## Sub-features

- `header` Spaces and Done never share a row with the tabs; a long tab list
  scrolls in its lane.
- `cards` every pane shows its own screen text within a few seconds; a pane
  that printed nothing says so instead of a blank card.
- `one-pane` a one-pane tab is one card beside New pane, not a screen-high box.
- `actions` tap a card opens that pane; long-press renames or closes (see
  `action-sheet.md`); × closes after a confirm; Right / Below open the agent
  picker for the new pane.

## How to get to it (user POV)

Open an agent, tap the pane counter in the header.

## Driving it with the private stack

Preconditions: a release APK per side (`perf/buildPrApk.mjs` through
`fm-mem-gate.sh` with `FM_MEM_JOB_GB=16`), the shared emulator lock, `yarn build`.

```sh
flock -o -w 3600 /tmp/fm-muxr-emulator.lock timeout 1800 fm-mem-gate.sh \
  node .agents/skills/done-done-verify-pockit/features/paneSwitcherLab.mjs \
  --apk <apk> --evidence <ev>/<side> --avd-home <scratch>/avd
```

The fake stack is three tabs (`main` and `review` of four panes, `shell` of
one); the lab has every pane print a few demo lines through the fake Herdr's
`pane.send_text`, so the previews show real `pane.read` text. Each cell
directory (`390-1.0-light`, `390-1.0-dark`, `270-1.0-dark`, `270-2.0-light`)
holds `switcher-<cell>.png` and `switcher-one-pane-<cell>.png` with their
`visualCheck.mjs` dumps; `journey.log` lists every DEFECT.

## Gotchas

- The session screen is always dark, so the switcher is dark in either app
  theme; the light cells prove nothing leaks the app's light surface into it.
- The fake's `pane.read` puts the pane's title and `ready.` above what it
  printed; that is the fake's screen, not the card's text.
