# Keep a shell usable after a crashed fullscreen agent

When a fullscreen agent (or a small stick-modes program) turns on alternate
screen and mouse reporting and then exits or crashes without clearing them,
Herdr keeps no scrollback and still hands a swipe to the pane as mouse-wheel
reports. A swipe would type SGR garbage like `64;19;6M` into the shell. Muxr
reads the pane's foreground from Herdr's process list instead of from the
output: a wheel report goes out only while a program, not the pane's own
shell, holds the pane, and once a program that was seen there is gone the host
clears the alternate-screen and mouse modes it left behind.

## Sub-features

- `wheel-gate` the pane's own shell in the foreground: the swipe is dropped,
  never turned into a program wheel report. Herdr's output does not re-send the
  alternate-screen or mouse modes, so the process list is the signal.
- `mode-reset` a program that was seen holding the pane and has since gone
  (stick script: `printf` alt-screen + mouse, then kill) leaves the shell with
  scrollback (`max_offset_from_bottom > 0`) and no SGR text on the prompt.
- `mode-reset-stopped` a `^Z` (stop) of the same stick program is not a crash:
  its pid still exists, so its alt-screen and mouse modes survive and `fg`
  returns to the same screen. The swipe is dropped either way.
- `scrollback-swipe` after that restore, swipes move `offset_from_bottom` and
  the visible command line stays free of `64;…;M`.

## How to get to it (user POV)

- Home → a shell pane where a fullscreen agent just crashed (or run the stick
  script below) → swipe the terminal.

## Driving it with the private stack

Preconditions:

- `yarn tsc --build apps/host`. Isolated Herdr lab via `HERDR_LAB_HELPER` (this
  home's `fm-herdr-lab.sh`). Never the live `default` session.
- Evidence dir outside the worktree, e.g.
  `$FM_HOME/data/rd-shell-scroll-garbage/`.

1. Unit + flow: from `apps/host`,
   `vitest run src/agent/infrastructure/terminalModes.test.ts`. Its flow test
   wires `paneForegroundPids` / `restorePaneTerminalModes` into
   `TerminalManager` and drives real swipes: shell foreground drops, a live
   program wheels, a stopped pid is spared, a gone one resets.
2. Lab restore: a host-like script that attaches `TerminalManager` with
   `paneForegroundPids: (paneId) => source.paneForegroundPids(paneId)` and
   `restorePaneTerminalModes`, drives a real Herdr pane and sends
   `terminal.scroll` swipes. Fill scrollback with `seq`, run a stick script that
   prints `\e[?1049h\e[?1000h\e[?1006h` and `kill -9 $$`, confirm
   `max_offset_from_bottom === 0`; a swipe after the crash must drop the wheel.
   Drive one swipe while the stick program still runs first, so the host has
   seen it: the swipe after it is killed must then also restore scrollback and
   leave no `64;…;M` on the prompt.
3. Live program: the same harness while the stick program still runs; the swipe
   must reach it as wheel reports (its own process keeps the pane), and nothing
   is reset.
4. Stopped program: start the stick program in the foreground, send `^Z`
   (stop) instead of killing it, swipe, then `fg`. The pane must come back to
   the same alternate screen with mouse reporting still on and no
   `?1049l`/`?1000l` on its input.
5. Attach after the crash: a fresh attachment onto the sticky pane clears
   nothing (no program was seen), and the swipe is still dropped — the command
   line stays free of `64;…;M`.

## Gotchas

- `$$` inside `( … )` is the parent shell — use a script or `bash -c` so only
  the child dies.
- Writing reset CSI through `/proc/<shell_pid>/fd/1` injects as program output;
  opening `/dev/pts/N` alone is less reliable.
- The owner is the last non-shell pid Herdr's `foreground_processes` reported
  while a program held the pane; it is "gone" only when `kill(pid, 0)` says
  `ESRCH`. A stopped (`^Z`, state `T`) or backgrounded program still exists, so
  it is left alone; a pid the kernel reused reads as still there. Linux and
  macOS alike.
- An empty owner is never "gone": attaching to a pane whose program already
  left (crashed or stopped) clears nothing, because there is no pid to tell a
  crash from a stop. The swipe is still dropped, so the command line stays
  clean; the modes are cleared once a program is seen and then disappears.
- A scroll is only gated when Herdr holds no scrollback for the pane; with
  scrollback it moves Herdr's own viewport. Latest uses the same rule.
