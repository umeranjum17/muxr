# Ask whether the phone is driving this pane

`muxr preview status` answers one question from inside a Herdr pane: is a
human on the phone currently driving this pane's browser or emulator
(`human`), or not (`none`)? A pane can only ever read its own lease.

## Sub-features

- `preview-none` no controller: prints `none`.
- `preview-json` `--json` prints the full record instead of the bare word.
- `preview-unavailable` clear failure when the loopback or its token is absent.

## How to get to it (user POV)

- Inside a Herdr pane, run `muxr preview status` before opening a browser or
  emulator chip the phone might already be driving.

## Driving it with the private stack

Preconditions:

- Baseline stack from `../SKILL.md` **including the naming loopback**
  (Launch step 4) with the same `MUXR_NAMING_PORT` exported for the CLI call.
- The host/naming loopback has had a moment to write
  `$MUXR_HOME/naming/token` (it is created at loopback startup).

- **No controller.** From inside your pane:
  `node scripts/cli.mjs preview status` exits `0` printing `none`.
- **JSON record.** `node scripts/cli.mjs preview status --json` exits `0`
  printing `{"ok":true,"controller":"none",…}`.
- **Unavailable (failure path).** With the naming loopback stopped (or a
  `MUXR_HOME` that has no `naming/token`), the same command exits `1` with
  stderr naming the missing piece (`… unavailable; start the local muxr host
  first`).

## Gotchas

- The answer is pane-scoped: `HERDR_PANE_ID` of *this* pane is the only input;
  there is no flag to ask about another pane, by design.
- The CLI and the loopback must agree on the port: without the private
  `MUXR_NAMING_PORT`, the CLI would ask the owner's real loopback on 8797 —
  never do that from a verification run.
- `human` requires a live phone lease; from a private stack with no paired
  phone, `none` is the expected and correct answer (do not fake a lease).
