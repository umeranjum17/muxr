# Scroll a pane and come back with Latest

A finger drag moves a pane's output with the finger, in every kind of pane, and
Latest brings it back to the newest output, also while the agent is still
printing. Inline agents (Codex, pi) and the shell scroll in Herdr's own
scrollback. Full-screen agents (OpenCode, Claude Code) scroll themselves: muxr
turns the drag into wheel reports sized to how far that program moves per
report. Latest is muxr's pill under the terminal everywhere except Claude Code,
which draws its own `Jump to bottom`.

## Sub-features

- `latest-drag` a slow drag back moves the text about as far as the finger, not two or three times further.
- `latest-fling` a fling keeps going back; nothing jumps or stutters.
- `latest-pill` once scrolled back, the pill reads `Latest` (accessibility label `Jump to latest output`); none in Claude Code, which shows its own `Jump to bottom`.
- `latest-reach` tapping it lands on the newest line, and the pill goes away.
- `latest-streaming` the same while the agent is still printing: the pane lands on the live edge and keeps following new lines; the pill does not stay on `Still catching up`.
- `latest-split` all of the above with the app in half of a split screen (iPad Split View, Android split screen).

## How to get to it (user POV)

- Home -> an agent (or a shell pane) with a long answer -> drag the output down, then tap `Latest`.

## Driving it with the private stack

Preconditions:

- `yarn build`. A real Herdr lab (`HERDR_LAB_HELPER`, `FM_HERDR_LAB_STATE_DIR`)
  and the harnesses on PATH: `opencode`, `claude`, `codex`, `pi`. A mise shim
  for `opencode` resolves under the lab's HOME and downloads instead; put the
  real binary first on PATH.
- The app on a device: a release APK from `node perf/buildPrApk.mjs <out>` on an
  owned emulator `SERIAL` (or the test phone under its keeper lock), or a native
  iOS build on a simulator or iPad.

1. `mkdir -p "$EVIDENCE"`, then from the repo root, in its own shell:
   `SERIAL=<serial> EVIDENCE=$EVIDENCE node --input-type=module -e "$(< .agents/skills/verify-muxr/features/terminalLatestLab.mjs)"`.
   Keep stdin attached. `KINDS=opencode,shell` narrows the panes; every model is
   the canned fixture `labStub.mjs`, so no account or credential is involved.
   For an iPad or another device on the network, leave `SERIAL` unset and set
   `MUXR_RELAY_HOST` to an address it reaches; `pair` then writes the link to a
   private file, to open with `devicectl device process launch --payload-url`
   aimed at the app's own bundle id.
2. Enter `pair`, tap `Pair` on the device. Then `stream` (or `stream opencode`):
   each pane prints 400 numbered `MARK-n` lines at 15 a second.
3. Record the screen. Open the pane, drag back slowly, fling, tap `Latest`.
   Once with the output finished, once while it is still printing.
4. Compare the `MARK-n` numbers before and after the drag against how far the
   finger moved; after Latest the last visible `MARK-n` must be the newest one,
   and while printing it must keep rising.
5. `quit` stops the panes, the host, the relay and the fixture.

## Gotchas

- Before the fix, OpenCode moved three rows for every row dragged, showed no
  Latest at all, and Latest from the host ended in `catching-up` while it printed.
- Herdr reports no scrollback for a full-screen program, so the host reads the
  pane's visible text to learn its step per wheel report; a pane that cannot be
  read keeps one row a report.
- On iOS, a `muxr://` link opened by the system goes to whichever muxr app
  claims the scheme; launch the payload against the exact bundle id instead.
- The lab never prints the pairing offer to its logs; keep it that way.
