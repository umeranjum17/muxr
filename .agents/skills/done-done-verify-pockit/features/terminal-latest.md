# Scroll a pane and come back with Latest

A finger drag moves a pane's output with the finger, in every kind of pane, and
Latest brings it back to the newest output, also while the agent is still
printing. A shell (and an agent printing inline) scrolls in Herdr's own
scrollback. Full-screen agents (OpenCode, Claude Code, and current Codex and pi)
scroll themselves: the host turns their wheel in bursts and reads the screen
after each, so the view stops where the finger did, also in Claude Code, which
accelerates a fast run of reports. Latest is muxr's pill under the terminal,
except in Codex, whose own `Back to bottom` (esc on the key row) stays the only
one. Claude Code's and pi's own hints need Ctrl+End, which the key row cannot
send, so they get the pill beside the hint. OpenCode's pill sends its own End
key and Claude Code's its own Ctrl+End instead of muxr turning their wheel.

## Sub-features

- `latest-drag` a slow drag back moves the text about as far as the finger, not two or three times further, and stops when the finger does: no crawl after it lifts.
- `latest-fling` a fling keeps going back; nothing jumps or stutters.
- `latest-pill` once scrolled back, the pill reads `Latest` (accessibility label `Jump to latest output`); none in Codex, whose `Back to bottom` is esc on the key row.
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
   `SERIAL=<serial> EVIDENCE=$EVIDENCE node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/terminalLatestLab.mjs)"`.
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

Without a device, `drag [kind rows ms]` (e.g. `drag claude 60 2000`) plays a
phone drag over the real terminal stream, paced like the app's scroll gate,
then Latest 3 s after the finger lifts (`LATEST_KEY='\u001b[1;5F'` sends
Claude's Ctrl+End the way the app does, unset it sends the host's Latest). It
writes `drag-<kind>.log`: the visible `MARK-n` range and `back=`, the rows the
view has moved, every ~170 ms. A drag of 60 must end near `back` 60 and stop
changing within a few hundred ms of `finger up`; `STUB_LPS=100 LINES=1200` and
a `stream` a few seconds before the drag covers it while Claude prints.

## Gotchas

- Before the fix, OpenCode moved three rows for every row dragged, showed no
  Latest at all, and Latest from the host ended in `catching-up` while it printed.
- While OpenCode is still writing a reply it ignores the wheel turned down, so a
  drag toward the newest lines does nothing until it finishes, and a quick run of
  turns overshoots its end into blank rows. Its End does neither. 400 lines can
  finish before the tap lands, so check `latest-streaming` with `LINES=1200`.
- Herdr reports no scrollback for a full-screen program, so the host reads the
  pane's visible text after each wheel burst to pay the drag in rows the screen
  really moved; a pane that cannot be read turns a row a report. Herdr answers
  each socket call on a ~100 ms tick, which sets the pace: one burst per tick,
  up to ~130 rows a second in Claude Code.
- Before the fix, a 60-row drag on a fullscreen Claude Code moved 10 rows by
  the time the finger lifted, then crawled on for seconds; while Claude printed
  it did not leave the live edge until the finger had stopped. Latest turned
  the wheel and stopped 17-23 rows short of the newest line.
- On iOS, a `muxr://` link opened by the system goes to whichever muxr app
  claims the scheme; launch the payload against the exact bundle id instead.
- The lab never prints the pairing offer to its logs; keep it that way.
- iPad Split View cannot be set up by XCUITest: picking the second app opens it
  full screen. Cover split width with Android split screen instead; the step per
  wheel report is measured from the pane's text, so it does not depend on width.
- Start an emulator on its own console port and check nothing else owns the
  next one: another lane's emulator on it answers your `adb -s` serial.
