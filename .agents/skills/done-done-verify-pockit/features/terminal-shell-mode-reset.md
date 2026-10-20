# Keep a shell usable after a crashed fullscreen agent

A fullscreen program can leave alternate screen and mouse reporting on after a
crash. Herdr then holds no scrollback and turns a swipe into wheel reports.
Muxr drops those reports while the pane's own shell is foreground, instead of
typing SGR garbage like `64;19;6M` into its line editor. It restores the modes
only when no live job remains, including when the crash preceded attachment.

## Sub-features

- `wheel-gate` shell foreground: drop the swipe, never send a program wheel.
- `wheel-gate-mid-drain` a fling outlives its program: every queued wheel step
  asks the pane's foreground again, so the rows still owed stop once the
  program exits and the shell receives no wheel escapes.
- `mode-reset` an observed program dies: restore primary-screen scrollback.
- `mode-reset-unseen` a program dies before any terminal attachment: restore
  scrollback without needing a previously observed owner pid.
- `mode-reset-stopped` a program stopped with `^Z`, before or after attachment,
  keeps its alternate screen and mouse modes. The same holds after `bg`.
- `scrollback-swipe` after restoration, a subsequent swipe moves Herdr's
  `offset_from_bottom` above zero without putting SGR text on the prompt.
- `mode-reset-latest` Latest uses the same safe restoration rule as a swipe.

## How to get to it (user POV)

Home → a shell pane where a fullscreen program crashed → swipe the terminal.

## Driving it with the private stack

Use the done-done-verify-pockit relay/host recipe with a **real** Herdr source (not
`--fake`) in a disposable **non-default** session. Every Herdr call goes through
`HERDR_LAB_HELPER run "$HERDR_LAB_SESSION" …`; provision/teardown through the
same helper, with cleanup installed before provisioning. Give the host its own
HOME, XDG directories and MUXR_HOME. Bound each host repro to 120 seconds and
close terminal streams, the paired link, host and relay before teardown.

1. Build: `yarn tsc --build apps/host apps/relay`. The existing
   `apps/host/src/agent/infrastructure/terminalModes.test.ts` flow checks the
   manager's wheel/restore decisions; it does not replace this real-host proof.
2. Create a shell pane through the paired lab client's `session.start`. Print
   `seq 1 240` to seed primary-screen scrollback. Run a child program that
   prints `\e[?1049h\e[?1000h\e[?1006h` and waits. Keep ISIG enabled
   (`tty.setcbreak(0)`, not raw mode) so `^Z` really stops it.
3. **Before attaching any terminal**, kill that child with `SIGKILL`. Confirm
   Herdr reports the pane's shell in `foreground_processes` and
   `max_offset_from_bottom === 0`. This reproduces the pre-attachment gap.
4. Open the real host's `terminal` link stream with the pane's session route,
   `newTerminalChannel()`, an explicit grid and `mode: 'control'`. Wait for its
   successful attach result. Send `terminal.scroll` up, then another swipe
   after restoration. On main the maximum remains zero; on the candidate the
   maximum **and** offset become positive. Read them back with `pane get`.
5. On a fresh pane, stop the same child with `^Z` **before attachment** instead.
   Confirm state `T`, shell foreground and maximum zero. Attach, swipe and send
   `terminal.bottom`: the child must remain stopped, maximum must remain zero,
   and no `?1049l` may be written. Audit actual successful reset writes (a
   preload around `fs.writeSync` may log only buffers containing `?1049l`),
   rather than inferring no write from the final screen. Then `fg` must return
   to the same program. Repeat with an observed program to retain that path.
6. Also run the crash case with `terminal.bottom` as the first action, and a
   live foreground program: Latest restores the crash, while the live program
   keeps its screen. Keep the existing wheel-proxy/per-frame-probe findings
   out of this change; this proof does not qualify their performance or claim
   that foreground implies mouse reporting.
7. Mid-drain exit (`wheel-gate-mid-drain`): a program that repaints on every
   wheel report and dies after 20 of them, without `?1049l` or `?1000l`. Send a
   500-row `terminal.scroll` up as the fling. Once 20 reports have landed the
   program exits; 4 s later the pane's foreground must be the shell alone, no
   further report may reach the program's log, and `pane read` must show no
   `\d+;\d+;\d+M` wheel escape text. The same run against the pre-fix manager
   prints those escapes, so an empty screen is real evidence only with that
   control beside it.

## Native capture

Pair the same lab host to a release APK on one task-owned Android emulator.
Hold `flock -o -w 7200 /tmp/fm-muxr-emulator.lock` for the entire journey;
start it through the memory gate and use `adb -s "$SERIAL"` on every call.
Capture the crashed pane before and after a real downward terminal drag at
393 dp, font 1.0, light and dark, and 270 dp, font 2.0, light and dark. Use
`visualCheck.mjs` from this skill for each PNG/XML pair. Save one motion
recording and read Herdr's offset back after the drag. The stopped pane's
before/after write audit must remain empty. Stop the exact emulator, host and
relay processes when the proof ends. Name all captures in the PR.

## Limits and safety

- No owner pid is persisted or inferred. A previously observed pid may veto a
  reset while it exists; an absent owner no longer prevents recovery.
- At the reset writer, Herdr must explicitly report the pane shell foreground,
  with no other foreground program. The shell must also have no child:
  `/proc/<shell>/task/<shell>/children` on Linux, `ps -A -o ppid=,pid=` on
  hosts without /proc. Missing/failed child inspection refuses the reset.
- Any child blocks recovery, including unrelated background servers and zombies.
  This deliberately misses crashes while another job remains. An orphaned or
  daemonized program no longer parented by the shell cannot be found by this
  witness; this does not attempt arbitrary process-tree ownership recovery.
- `$$` inside `( … )` is the parent shell. Use a separate script or `bash -c`
  so `kill -9` never kills the pane shell.
- Only panes where Herdr owns no scrollback enter the reset path. Once restored,
  scrolling uses Herdr's primary-screen viewport again.
