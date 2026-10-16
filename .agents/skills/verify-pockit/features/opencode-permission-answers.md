# Answer an OpenCode permission prompt in one tap

When OpenCode stops on its own "△ Permission required" box (for example
"Access external directory /etc" with `Allow once`, `Allow always` and
`Reject` in one row), the agent's terminal shows those three as the same
answer chips other agents get, above the composer. A tap moves from the
selected button to the tapped one with Left/Right and presses Enter, so the
answer never depends on knowing OpenCode's keys. `Needs you` clears once
OpenCode takes the answer.

## Sub-features

- `opencode-permission-chips` the three chips show with OpenCode's full
  labels even at phone width, where the row is cut off at the grid edge
  (`Allow alway`, or Reject gone entirely at about 33 columns).
- `opencode-permission-selected` a tap answers the tapped button whichever
  button is selected. OpenCode marks the selection only by its background, so
  the chips read the pane in colour (`pane.read` with `ansi: true`).
- `opencode-permission-always` `Allow always` also confirms OpenCode's
  follow-up "Always allow · Confirm / Cancel" step in the same tap: Herdr
  reports that step as idle, so no chips would ever show for it.
- Numbered (`❯ 1. Yes`) and highlighted-row (folder trust) prompts are
  unchanged ([agent-trust-answers.md](./agent-trust-answers.md)).

## How to get to it (user POV)

Ask an OpenCode agent to read a file outside its folder ("Read the file
/etc/os-release and tell me the distro"). Open the agent: the chips sit above
the composer while the box shows. Tap one.

## Driving it with the private stack

Preconditions: real Herdr (the fake stack draws no OpenCode box), a guarded
non-default lab session (`fm-herdr-lab.sh provision`), the real `opencode`
first on the lab `PATH`, and the release APK / PWA of
[agent-trust-answers.md](./agent-trust-answers.md). The box is OpenCode's
own whatever the model, so no key is needed: `opencodePermissionLab.mjs` runs
relay, host and a real OpenCode on a local stand-in model ("Lab stand-in")
whose first answer reads `/etc/os-release`. Run it from the repo root with
`HERDR_LAB_HELPER`, `EVIDENCE` and (native) `SERIAL` set, stdin from a fifo:
`node --input-type=module -e "$(< .agents/skills/verify-muxr/features/opencodePermissionLab.mjs)"`.
Its stdin takes `pair` (native, on `SERIAL`) or `pair browser` (writes the
link for `window.__MUXR_LAB_PAIR__`), `start`, `ask`, `look <name>`, `quit`.

1. `start`, open the agent on the device, dismiss OpenCode's "Update
   Available" box with the key row's esc (it eats the first prompt), then
   `ask`. `look` logs `blocked`.
2. Capture the chip band, tap `Allow once`, and capture the reply naming the
   distro; `Needs you` is gone and the pane reads `working`, then `idle`.
3. Prompt again, tap `Reject`, capture OpenCode's rejected tool line and no
   reply from the file.
4. `Allow always`: one tap lands on the reply with no Confirm box left. It
   holds until OpenCode restarts, so start a new agent for any later run.
5. Extreme cases: 270 dp at font 1.3, dark and light; the installed PWA at
   393 px.

## Gotchas

- Reading `/etc` asks only once per OpenCode run after `Allow always`; a
  second prompt in the same agent goes straight through.
- OpenCode 1.18 crashes when the grid shrinks at 270 dp (keyboard opening);
  send the prompt with Gboard disabled, or from the key row's text box, and
  never resize the terminal while the box shows.
- For a quick host-only check of the parser on a real screen, read the lab
  pane with `fm-herdr-lab.sh run <session> pane read <pane> --source visible
  --format ansi`.
