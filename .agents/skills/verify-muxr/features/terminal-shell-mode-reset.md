# Keep a shell usable after a crashed fullscreen agent

When a fullscreen agent (or a small stick-modes program) turns on alternate
screen and mouse reporting and then exits or crashes without clearing them,
Herdr keeps no scrollback and still accepts wheel reports. A swipe would type
SGR garbage like `64;19;6M` into the shell. Muxr restores primary screen and
mouse-off once the program that set those modes is gone, and sends wheel
reports only while mouse reporting is on — so a swipe scrolls Herdr's own
scrollback again and the command line stays clean.

## Sub-features

- `wheel-gate` with mouse reporting off or not yet learned, a swipe is not
  expanded into program wheel reports.
- `mode-reset` after a stick-modes crash (`printf` alt-screen + mouse, then
  kill), the shell returns to scrollback (`max_offset_from_bottom > 0`) without
  SGR text on the prompt.
- `mode-reset-stopped` a `^Z` (stop) of the same stick program is not a crash:
  the pid stays in the pane, so its alt-screen and mouse modes survive the
  swipe and `fg` returns to the same screen.
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
4. Stopped program: same lab pane, start the stick program in the foreground,
   send `^Z` (stop) instead of killing it, swipe, then `fg`. The pane must come
   back to the same alternate screen with mouse reporting still on and no
   `?1049l`/`?1000l` on its input.

## Gotchas

- `$$` inside `( … )` is the parent shell — use a script or `bash -c` so only
  the child dies.
- Writing reset CSI through `/proc/<shell_pid>/fd/1` injects as program output;
  opening `/dev/pts/N` alone is less reliable.
- A program is "gone" when the pane's shell has no live child left, so a
  stopped (`^Z`, state `T`) program is deliberately left alone and a background
  job also defers the reset. Reading `/proc/<shell_pid>/task/<shell_pid>/children`
  is what separates stopped from exited; Herdr's `foreground_processes` lists
  the shell for both.
- Unknown mouse mode (attach mid-program, before the repaint is parsed) drops
  the gesture too: a scroll Herdr would turn into wheel reports may only go
  once mouse reporting is known on. Latest uses the same rule.
