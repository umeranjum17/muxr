# Keep an agent's grid tall enough when the keyboard opens

Opening the phone keyboard over an agent never hands its pane fewer than 24
rows, and a narrow grid (a large font) gets more: rows enough for 900 cells.
On a short screen the terminal keeps those rows and the box follows the pane's
cursor: its last row is the agent's prompt, with the newest reply right above
it. A drag pans the hidden rows into view before it scrolls the pane. OpenCode 1.18 and 1.19 die with a
bun panic (`Illegal instruction (core dumped)`) on a short grid, and the
keyboard on the 270 dp reference phone leaves room for 7; with the floor it
keeps running and answers.

## Sub-features

- `floor-keyboard` tapping the prompt box on a 270 dp phone opens the keyboard and the pane keeps at least 24 rows in Herdr; OpenCode stays up.
- `floor-reply` a prompt typed with the keyboard open reaches OpenCode, which answers from `opencode-go/muse-spark-1.3-contributor`.
- `floor-follow` with the keyboard up, the box ends on the cursor's row (OpenCode's prompt), so the reply above it shows; the status lines under the prompt are off the bottom.
- `floor-pan` with terminal font 20 (about 22 columns, 41 rows) and the keyboard closed, a downward drag shows the grid's top rows before OpenCode scrolls; an upward drag brings the status lines back. Typing to the pane follows the cursor again.
- `floor-roomy` on a 393 dp-class screen nothing changes when the grid already holds 24 rows or more.
- `floor-pwa` the same in the installed PWA.

## How to get to it (user POV)

- Home -> New agent -> OpenCode in a folder -> tap `Type a prompt…` (the keyboard opens) -> type a question -> send.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>` on an
  owned emulator `SERIAL` at 1080x2376, density 640 (270 x 594 dp). A real Herdr
  lab (`HERDR_LAB_HELPER`, `FM_HERDR_LAB_STATE_DIR`).
- OpenCode: the lab pane's mise shim installs the latest into the lab's own
  data dir (1.19.0 crashes the same way as 1.18.25).
- For `floor-reply`, an OpenCode Go key in a 0600 file, `GO_KEY_FILE`. The lab
  types it into OpenCode's own `opencode auth login` in a lab pane; it is never
  printed, and the phone never shows it. Without it the check still proves the
  floor and the crash; the reply needs the key.

1. `mkdir -p "$EVIDENCE"`, then from the repo root, in its own shell:
   `SERIAL=<serial> EVIDENCE=$EVIDENCE GO_KEY_FILE=<file> node --input-type=module -e "$(< .agents/skills/verify-muxr/features/terminalFloorLab.mjs)"`.
   Keep stdin attached. It prints the folder OpenCode should work in.
2. `signin`, then `pair` and tap `Pair` on the phone.
3. On the phone: New agent -> OpenCode -> that folder -> Start. Wait for
   OpenCode's screen; its status line names the model.
4. Start a screen recording, then enter `kbd`: the lab taps the prompt box,
   waits for the keyboard and reads the open pane's rows from Herdr. It writes
   `PASS the open pane holds >= 24 rows and did not crash` (or `FAIL …`) to
   `$EVIDENCE/lab-timeline.log` and each pane's last screen next to it.
5. Type `What does calc.py do?` and send, keyboard still up. Capture the reply
   above OpenCode's prompt. `check` again afterwards.
6. Close the keyboard, set Settings -> Appearance -> Text size -> 20 pt (on
   native, Terminal controls -> Appearance zooms the same setting) and capture;
   `pan down` (quick drags inside the visible box) and capture the top rows;
   `pan up` and capture the bottom ones.
7. Repeat at density 420 (`adb shell wm density 420`), and in light and dark.
8. `quit` stops the panes, the host and the relay, and tears the lab down.

Before #844 the same `kbd` read 7 rows and `CRASHED` on a 270 dp phone. Before
the pan, a main build showed only OpenCode's prompt and status with the
keyboard up, and at font 20 its top rows could not be reached.

## Gotchas

- The floor is `MIN_TERMINAL_ROWS` / `MIN_TERMINAL_CELLS` in
  `apps/mobile/sources/terminal/domain/terminalFloor.ts`; the lab reads the row floor from there. The probe
  behind it, a bare pty: at 37 columns OpenCode survives 22 rows and panics at
  every height from 21 down to 12, even when launched at that size. Narrower
  needs more: 31 x 22, 29 x 24, 26 x 24 and 22 x 24 panic; 31 x 26, 29 x 32,
  26 x 30 and 22 x 40 live.
- Herdr's `pane list` gives a pane's rows as `scroll.viewport_rows`.
- The row the box follows is the cursor Herdr puts back at the end of every
  frame (`ESC[row;colH`, then `ESC[?25h`); a frame with the cursor hidden
  leaves the last shown row. No cursor yet means the bottom rows show.
- The key must stay out of every recording and screenshot: stop recording
  before `signin`, and never `pane read` the sign-in pane.
- At 270 dp the New agent Folder field scrolls under the sticky Start button;
  scroll on until it clears, or the tap lands on `Start OpenCode in ~`.
- An agent the phone starts in a folder under `/home/umer` meets mise's
  "config files are not trusted" prompt (the lab HOME is not the real one);
  `mise trust ~/.config/mise/config.toml` in a lab pane records the trust in
  the lab's own state only. Do it before `signin` too, or the sign-in waits
  on that prompt and times out.
- On web at 270 dp, opening the keyboard can throw React error #185 (maximum
  update depth) into "Something went wrong". main does the same with the
  same stack (2026-10-12), so it is not the floor. Retry recovers.
- A slow drag (600 ms) pans about one row on native; `pan` uses quick strokes.
  Android's font scale does not change the terminal font; only Text size does.
- A renderer keeps the grid it attached at, so after a font change the grid can
  stay taller than the floor asks for; the pan covers every row it drew.
- On web, emulate the phone at DPR 1: at DPR 4 xterm draws giant glyphs. The
  PWA's service worker keeps a stale bundle across a rebuild: unregister it and
  clear its caches before reloading.
- The terminal screen is dark in the light theme too.
