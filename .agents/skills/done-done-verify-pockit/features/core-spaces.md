# Spaces, tabs and panes on Herdr Core (lab only)

jg-kile slice 8. On a host that reads Herdr Core (`--herdr-core-lab`, lab only, a real home refuses it),
Home groups agents by space and tab, and New tab, Rename, a split, Close pane and Close workspace work.
Core keeps each machine's layout in the opaque document `herdr-app`: `spaces[]` with `tabs[]`, each tab a
`root` node of `block` (one terminal), `row`, `column` or `stack`. That is the Herdr app's own format, not a
published API, so `domain/herdrAppLayout.ts` reads what it needs and keeps every other field as found; a write
names the version it read (`infrastructure/herdrCoreLayoutStore.ts`) and retries on `conflict`. A document muxr
cannot read is never written over, and agents are listed by their `herdr.space` and `herdr.tab` labels.

## Rules it proves

- The document's names win over the labels: Home reads Pockit/Fixes, not the label `pockit`.
- Unknown fields (a top-level `future`, a space's `pinned`, a tab's `accent`, a row's `gap`) survive every write.
- New tab starts the anchor's agent kind in a new tab of the same space; a split puts the new agent beside the
  anchor (a row for right, a column for down); closing a pane, tab or space ends its agents and tidies the document.
- Not built: renaming an agent or a pane, a pane without an agent (Shell), the pane grid.

## Run

```sh
yarn build
MUXR_LAB_APK=<x86_64 release apk> MUXR_LAB_AVD_HOME=<scratch avd home> \
  flock -o -w 3600 /tmp/fm-muxr-emulator.lock done-done verify core-spaces --outcome "<claim>"
```

The lab Core is seeded the way the Herdr app leaves it: three agents (labels pockit/fix-login, pockit/review,
notes/notes) and a document that names the spaces Pockit (tab Fixes, two panes in a row) and Notes (tab Daily).

Break test: in `renameTab`, build the tab as `{ id: tab.id, name, root: tab.root }` instead of `{ ...tab, name }`,
rebuild; the journey ends with `DEFECT the Herdr app's own fields were lost`.
