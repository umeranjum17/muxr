# Keep a shell usable after a crashed fullscreen agent

When a fullscreen agent (or a small stick-modes program) turns on alternate
screen and mouse reporting and then exits or crashes without clearing them,
Herdr keeps no scrollback and still accepts wheel reports. A swipe would type
SGR garbage like `64;19;6M` into the shell. Muxr restores primary screen and
mouse-off when only the shell is left holding those modes, and sends wheel
reports only while mouse reporting is not known off — so a swipe scrolls
Herdr's own scrollback again and the command line stays clean.

## Sub-features

- `wheel-gate` with mouse reporting known off, a swipe is not expanded into
  program wheel reports.
- `mode-reset` after a stick-modes crash (`printf` alt-screen + mouse, then
  kill), the shell returns to scrollback (`max_offset_from_bottom > 0`) without
  SGR text on the prompt.
- `scrollback-swipe` after that restore, swipes move `offset_from_bottom` and
  the visible command line stays free of `64;…;M`.

## How to get to it (user POV)

- Home → a shell pane where a fullscreen agent just crashed (or run the stick
  script below) → swipe the terminal.

## Driving it with the private stack

Preconditions:

- `yarn tsc --build apps/host`. Isolated Herdr lab via
  `HERDR_LAB_HELPER` (this home's `fm-herdr-lab.sh`). Never the live `default`
  session.
- Evidence dir outside the worktree, e.g.
  `$FM_HOME/data/rd-shell-scroll-garbage/`.

1. Unit: from `apps/host`,
   `vitest run src/agent/infrastructure/terminalModes.test.ts`.
2. Lab restore: `node $EVIDENCE/proof-lab-reset.mjs` (or re-create it from this
   recipe): fill scrollback with `seq`, run a stick script that prints
   `\e[?1049h\e[?1000h\e[?1006h` and `kill -9 $$`, confirm
   `max_offset_from_bottom === 0`, then the host's PTY mode-reset path restores
   scrollback without typing into the prompt.
3. Shared host path: `node $EVIDENCE/proof-tm-scroll.mjs` attaches
   `TerminalManager` to the sticky pane, sends `terminal.scroll` swipes, and
   checks the command line has no `64;…;M` while scrollback moves. Phone and
   installed PWA both use this path.

## Gotchas

- `$$` inside `( … )` is the parent shell — use a script or `bash -c` so only
  the child dies.
- Writing reset CSI through `/proc/<shell_pid>/fd/1` injects as program output;
  opening `/dev/pts/N` alone is less reliable.
- Unknown mouse mode (attach mid-program) must still expand wheels; only
  known-off blocks them. Latest uses the same rule.
