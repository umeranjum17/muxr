# Name the current workspace and pane

An agent names where it works: `muxr name` renames the current Herdr workspace
and pane through Herdr itself and records provider/model attribution, so every
client and the phone agree on the label.

## Sub-features

- `name-pane` sets the pane's human-readable title.
- `name-workspace` sets the workspace label.
- `name-attribution` records provider/model pane metadata for display surfaces.
- `name-report` prints the per-field apply result as one JSON line.

## How to get to it (user POV)

- Inside a Herdr pane, run
  `muxr name --workspace '<slug>' --pane '<title>' --provider '<provider>' --model '<model>'`
  (any subset; at least one value).
- See the result in Herdr's own workspace/pane listings and in muxr surfaces
  that lead with the task and say who under it.

## Driving it with the private stack

Preconditions:

- A Herdr pane you own in a **non-default** session, with its `HERDR_PANE_ID`
  in the environment (run inside the pane), and the `herdr` binary reachable
  (`HERDR_BIN_PATH`/`HERDR_BIN` when needed).
- The run's `MUXR_HOME` exported as in Launch.

- **Name the pane.** `node scripts/cli.mjs name --pane 'Verify task title'`
  exits `0` with stdout `{"ok":true,"status":"ok","results":{"pane":true}}`.
  Confirm through Herdr, not the CLI echo:
  `herdr --session <yours> pane get "$HERDR_PANE_ID"` shows the new title.
- **Name the workspace.** `node scripts/cli.mjs name --workspace 'verify-muxr'`
  exits `0` and `herdr --session <yours> workspace list` shows the label.
- **Attribution.** `node scripts/cli.mjs name --provider pi --model glm-5.3`
  exits `0`; `herdr --session <yours> pane get "$HERDR_PANE_ID"` (or
  `pane report-metadata` output consumed by display surfaces) carries the
  `provider=` / `model=` tokens from source `muxr.naming`.
- **Outside a pane (failure path).** With `HERDR_PANE_ID` unset, the same
  command exits `1` with stderr
  `muxr name: muxr name must run inside a Herdr pane (HERDR_PANE_ID is missing)`.

## Gotchas

- Names are used verbatim within bounded limits (no control characters; length
  capped). Do not trim or normalize a name to make a check pass — assert the
  rendered label Herdr now holds.
- Workspace membership is resolved from Herdr (`pane get`), never parsed out of
  the pane id string; a pane that Herdr cannot resolve fails loudly with
  `this pane is not available in Herdr`.
- Never run this against the `default` session or any pane you do not own; the
  rename is a real mutation of Herdr state.
- A leading `-` in a pane/workspace name is rejected (flag-injection guard);
  use names that do not start with a dash.
