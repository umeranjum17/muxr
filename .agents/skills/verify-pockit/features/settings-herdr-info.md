# See what runs your sessions from Settings

One `Herdr` row in the Settings machine list opens a sheet with one plain
sentence (muxr runs your sessions with Herdr on your computer), the exact
command to see those same sessions on the computer (`herdr agent list`) in a
monospace block, a Copy button with inline copied feedback, and a close
action.

## Sub-features

- `herdr-row` the machine list shows a `Herdr` row reading
  `Runs your sessions on the computer — see the command`.
- `herdr-sheet` tapping it opens a sheet titled `Herdr runs your sessions`
  with the plain sentence, the command block, Copy and Close.
- `herdr-copy` Copy writes `herdr agent list` to the clipboard and the
  button reads `Copied`.
- `herdr-command-true` the shown command lists the host's sessions: the host
  serves Herdr's default session, so no `--session` flag, and
  `herdr agent list` is the command the bug template and CONTRIBUTING already
  use where the app must agree with Herdr.

## How to get to it (user POV)

- Settings -> machine list -> `Herdr` -> read the sheet -> Copy -> Close.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>`
  installed on an owned emulator `SERIAL`. This drives the phone, so it uses
  `perf/lib/fakeStack.mjs` (real relay, host and E2EE pairing over a fake
  Herdr) instead of `../SKILL.md` Launch.
- A real-Herdr lab for the command truth (the fake stack has no Herdr
  sessions to list): provision a non-default session through the Herdr lab
  helper, run a real lab host against it, start a shell session through a
  lab device, report agent lifecycle on its pane, and run the sheet command
  shape (`herdr --session <lab> agent list`) through the helper.

- **Row and sheet.** Open Settings, scroll to the machine list, tap `Herdr`.
  The sheet reads `muxr runs your sessions with Herdr on your computer.`
  above `herdr agent list`.
- **Copy.** Tap Copy; the button reads `Copied`. The clipboard holds exactly
  `herdr agent list`.
- **Command truth.** The lab log shows `herdr agent list` empty before the
  host runs and listing the reported `Umer` agent after, against the real
  lab host.
- **Capture** with `adb -s $SERIAL exec-out screencap -p`: the row, the open
  sheet, and the copied feedback, at 270dp font 1.3 in dark and light and at
  412dp font 1.0; plus one simulator shot of the open sheet. The command
  block must wrap or scroll inside the sheet, never clip.

## Gotchas

- The shown command has no `--session` flag on purpose: a person's host
  serves the default session. The flag appears only in lab scoping, never in
  the sheet.
- The app reads the system theme at launch; a live `uimode` change shows the
  old theme until it is relaunched.
- Never run the lab host against the `default` session; the Herdr lab helper
  owns its non-default session and verifies the default fleet is unchanged
  at teardown.
