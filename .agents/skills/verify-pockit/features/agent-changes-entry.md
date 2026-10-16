# Find an agent's changes from the terminal screen

While the pane's project has uncommitted changes, the terminal header's
identity row carries a pill (`2 files changed`); Pane actions always opens on
a `Changes` row, with the count when there is one. Both open the existing
changes review (`/session/<id>/changes`), the same screen the quick-actions
ring's Changes slot opens. With a clean tree the pill is gone and the row has
no count.

## Sub-features

- `changes-pill` a dirty tree shows the pill in the header row (not a row of
  its own); a clean tree shows none. It refetches on focus and on every agent
  lifecycle move, so an agent going idle after its edits brings it up with the
  screen still open. A plain shell has no lifecycle, so it shows on refocus.
- `changes-pill-compact` where the words would not fit beside the title
  (width ÷ font scale under 360: a 270 dp phone, the largest text) the pill is
  an icon and the count; under 240 the lifecycle word gives way to it (the dot
  stays). The spoken label always reads `Review changes, N files changed`.
- `changes-row` Pane actions › Inspect starts with `Changes`; the menu's
  quick-actions fallback no longer repeats it.

## How to get to it (user POV)

- An agent edits files → its terminal screen header shows `N files changed` →
  tap it; or ⋮ (Pane actions) › Changes.

## Driving it with the private stack

Preconditions:

- `yarn build` and a lab-flag web export (see
  [lab-browser-pairing.md](./lab-browser-pairing.md)); for main-vs-candidate,
  export each tree and serve each on its own port (a new origin, so the
  service worker never serves the other build), pairing each.
- A real Herdr lab: run
  `EVIDENCE=<dir> node --input-type=module -e "$(< .agents/skills/verify-pockit/features/terminalFloorLab.mjs)"`
  with stdin attached (a FIFO works). It prints the folder; no `signin` is
  needed for this check.

1. In that folder: `git init` and commit everything (it starts with `calc.py`
   and `opencode.json`). Send the lab `browser`, pair the PWA with
   `window.__MUXR_LAB_PAIR__(<link>)`, then
   `<root>/herdr-lab.sh workspace create --cwd <folder> --label calc`.
2. Open the pane. Clean tree: no pill; Pane actions shows `Changes` with no
   count.
3. Edit two files from the lab pane
   (`<root>/herdr-lab.sh pane send-text w1:p1 '…'`): a change to `calc.py` and
   a new `test_calc.py`. To exercise the live refetch, report the lifecycle a
   finishing agent sends:
   `pane report-agent --source lab --agent opencode --state working --seq 1 w1:p1`,
   then `--state idle --seq 2`. The pill `2 files changed` appears with no
   reload.
4. Tap the pill: `Changes · master`, `calc.py +4`, `test_calc.py +5`. Back,
   ⋮ › Changes (count 2): the same screen.
5. Capture header and Pane actions at 390 and 270 px, font 1.0 and 2.0, light
   and dark, through `visualCheck.mjs pwa-check`; main shows no pill and no
   Changes row in the same cells.

## Gotchas

- The edit can come from a shell instead of a model: the pill reads real git
  state through the real host either way. Say so in the PR's Live proof.
- A shell's own window title is the full cwd; set a short title in the lab
  pane (`printf '\033]0;calc\007'`) so shots carry no scratch path.
- `pwa-check` flags the terminal canvas (`text over text: ""`) and every
  control under the open menu sheet (`covered control`) on main as well;
  compare against main's cell before calling a lead new. At font 2.0 the Pane
  actions sheet runs off the left edge on main too.
