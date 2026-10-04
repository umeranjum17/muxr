# Share a file into a pane's Shared Artifacts

An agent (or a user at the terminal) runs `muxr share <file>` inside a Herdr
pane; the file appears in that pane's durable Shared Artifacts timeline with
its bytes intact, and repeated shares of the same name get numeric suffixes
instead of overwriting.

## Sub-features

- `share-file` copies a file into the pane's timeline and prints `Shared <name>`.
- `share-collision` re-sharing the same name stores `verify-1.txt`, `verify-2.txt`, … (numeric suffix before the extension).
- `share-dotfile` renames a leading-dot file to `shared<original>`.
- `share-missing-target` a nonexistent path fails with exit code 1 and a clear stderr line.
- `share-view` `muxr artifacts status` shows the retention view of the same timeline.

## How to get to it (user POV)

- From inside any Herdr pane, run `muxr share <path>`; the pane id comes from
  the pane's own `HERDR_PANE_ID`.
- From anywhere, run `muxr share <path> --pane <pane-id>` naming a pane explicitly.
- Later, read the pane's timeline state with `muxr artifacts status`.

## Driving it with the private stack

Preconditions:

- Baseline stack from `../SKILL.md` is up and Doctor passes.
- A pane id in hand: run the commands inside a Herdr pane you own, or export
  `HERDR_PANE_ID=<pane-id>` / pass `--pane <pane-id>` for that pane.

- **Share a file.** Create a payload and share it:
  `printf 'verify-muxr artifact body\n' > "$RUN_ROOT/verify.txt"` then
  `node scripts/cli.mjs share "$RUN_ROOT/verify.txt"` (with the run's `MUXR_HOME`).
  Exit code `0`, stdout `Shared verify.txt`.
- **Confirm the durable side effect.** The stored copy exists with identical
  bytes: `ls "$MUXR_HOME/attachments/pane/$HERDR_PANE_ID/"` lists `verify.txt`,
  and `cmp "$RUN_ROOT/verify.txt" "$MUXR_HOME/attachments/pane/$HERDR_PANE_ID/verify.txt"`
  is silent (identical).
- **Collision suffix.** Share the same file again. Exit `0`, stdout
  `Shared verify-1.txt`; the pane directory now holds both `verify.txt` and
  `verify-1.txt`.
- **Dotfile rename.** `printf 'hidden\n' > "$RUN_ROOT/.secret-note"` then share
  it: stdout `Shared shared.secret-note` and the stored file is
  `shared.secret-note` (dotfiles never become invisible timeline entries).
- **Missing target (failure path).** `node scripts/cli.mjs share "$RUN_ROOT/does-not-exist.txt"`
  exits `1` with stderr `muxr share: no such file: $RUN_ROOT/does-not-exist.txt`.
  Nothing is created in the pane directory.
- **Read-only second view.** `node scripts/cli.mjs artifacts status` exits `0`,
  prints the retention policy (`keeps the newest … files of every pane`) and,
  on a fresh home, `No sweep has run on this machine yet.` — the same timeline
  the pane directory holds, from the reader's side.

## Gotchas

- Outside a Herdr pane with no `--pane`, the command fails with
  `no pane: run inside a Herdr pane (HERDR_PANE_ID) or pass --pane <id>` — that
  is the correct loud failure, not a bug.
- `--pane` values containing `/`, `\`, or being `.`/`..` are rejected as
  `invalid pane`; the stored directory can never escape the pane root.
- The completion is atomic: the file is copied to a `.share-*.tmp` name and
  linked into place, so a watcher never sees a half-copied artifact. Do not
  "simplify" proof by writing into the pane directory directly.
- Directories are rejected (`not a file: …`); share regular files only.
