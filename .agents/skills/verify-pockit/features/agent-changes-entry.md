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
- `changes-theme` the changes review follows the app theme, header and body
  alike, though it opens over the terminal, which is always dark. The terminal
  draws inside a `ScopedTheme name="dark"`, which Unistyles holds as one
  shared value while it renders; a scope that once did not finish left it `dark`, so
  the screen opened from it drew a dark body under a light header in light
  mode (fixed in `patches/react-native-unistyles+3.1.1.patch`: a scope reads
  its parent from React context).
- `changes-large-text` at width ÷ font scale under 200 (270 dp or 393 dp at
  font 2.0) the review's scope chips and Lines added / Lines removed / Files
  wrap onto more lines, and each file row drops its kind icon and chevron,
  wraps its name and shows its `+N / −N` under the path (a long one-word name
  breaks mid-word; the path keeps one line, ellipsized). At normal sizes a
  name longer than its row ends in `…` as before (`pwa-check` and OCR flag it
  as a lead).
- `sheet-narrow` under a 252 px window (`NARROW_SHEET_WINDOW`: the installed
  PWA at font 2.0) Pane actions fills the window less 16 px, its rows drop their
  icons and chevrons (`SheetIcon`) so labels wrap by word and counts stay
  inside, and the talk row wraps its button under the label. At 252 px and up
  (every native phone) it is pixel-identical to before.

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
6. `changes-theme`: per theme, load the terminal URL itself
   (`location.href = '<origin>/session/shell:w1:p1'`; reaching it from Home
   did not leak), open the review from the pill and from Pane actions, and
   shoot it. Light must be light from header to the last row. In the page,
   find the Unistyles module (`__r(i)` exporting `UnistylesShadowRegistry`)
   and read `UnistylesShadowRegistry.getScopedTheme()`: outside every scope it
   is `undefined`; the defect reads `dark`.
7. Large text: give the repo a change with a long name (e.g.
   `billing/monthly_statement_reconciliation_report.py`) and capture the
   review (tap the pill) and Pane actions (with `-scrolled`) in the full
   native + PWA matrix. At 270/2.0 every scope chip, summary label and count is
   on screen, and the PWA sheet sits inside the 135 px viewport. On native,
   `muxr://session/<session id>` (e.g. `shell:w1:p1`) opens the pane for each
   cell; on the PWA, set `location.href` to `/session/<id>` and tap the pill
   (a reload straight onto `/changes` lands on the agent screen).

## Gotchas

- Pane actions' Changes is the sheet's button after `Inspect` (accessible
  name `Review changes, N files changed`); the `Review changes, N` menuitem
  is the hidden quick-actions ring, and a scripted click there lands on other
  rows such as New pane.
- The edit can come from a shell instead of a model: the pill reads real git
  state through the real host either way. Say so in the PR's Live proof.
- A shell's own window title is the full cwd; set a short title in the lab
  pane (`printf '\033]0;calc\007'`) so shots carry no scratch path.
- `pwa-check` flags the terminal canvas (`text over text: ""`) and every
  control under the open menu sheet (`covered control`) on main as well;
  compare against main's cell before calling a lead new. Native Pane actions
  also reports `overlap … "Terminal surface"` for every row: the sheet floats
  over the terminal by design.
- Name the lab pane (`herdr pane rename w1:p1 calc`), or the shell's title
  puts the scratch path in the header.
