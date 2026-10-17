# Keep the agent title and composer controls whole on a narrow PWA

The installed PWA takes the system text size as page zoom, so at the largest
text a 270 dp phone lays the agent screen out at 135 CSS px and every
fixed-size control doubles against the width. Below 240 px the agent screen
keeps its header and composer whole: the header shows the task title and the
status dot only, and the composer rail puts the field on its own line with
`+`, the microphone and Talk (or Send) on the line under it. Native never gets
that narrow (only its text grows), so its header and rail are unchanged.

Before the fix the 135 px cell squeezed the title out of the header (or to
`U…`), drew `1/2` over the agent name and `Done` over ⋮, and left the prompt
field about one letter wide with the microphone over Talk.

## Sub-features

- `narrow-header` PWA 135 px: the title (`Umer`) is whole beside the status
  dot; no pager, glyph, name or status word. Tapping the title opens the pane
  overview, the same thing the `1/2` pager opens.
- `narrow-rail` PWA 135 px: the field spans the rail with `Prompt…` whole;
  `+`, the microphone and Talk sit whole on the line below. With a typed draft
  Talk becomes Send in the same place and the draft's words wrap whole.
- `wide-unchanged` PWA 393 px and native 270 dp / font 2.0: header and rail
  look as on main.

## How to get to it (user POV)

Set the phone's text size to the largest, open the installed muxr app and an
agent.

## Driving it with the private stack

PWA (`composer-restored-draft.md` has the same stack):

1. Export with the lab flag, start `browserPairLab.mjs`, serve the export and
   pair the standalone `--app=` window as in `lab-browser-pairing.md`.
2. Give the first agent the demo task title through the fake Herdr's socket
   (`<lab tmp>/herdr/herdr.sock`): one JSON line
   `{"id":"1","method":"lab.set_agent_status","params":{"pane_id":"w1:p1","agent_status":"idle","title":"Umer"}}`.
3. Per cell (`../SKILL.md` Visual check: 135x297 at DPR 4 and 393x864 at DPR
   2, light and dark): `emulate`, reload, open `Umer`, `screenshot` as
   `agent-<w>-<f>-<theme>` and run `visualCheck.mjs pwa-check`. Then focus
   `textarea[aria-label=Prompt]`, `type` `Umer draft for the narrow rail` and
   capture `agent-draft-<w>-<f>-<theme>`.

Native: a release APK on an owned emulator paired to `perf/lib/fakeStack.mjs`
(as `composer-restored-draft.md`), 270 dp font 2.0 and 393 dp font 1.0, light
and dark, open the agent and run `visualCheck.mjs`.

## Gotchas

- A rebuilt export keeps the same `index-<hash>.js` name, and the paired
  window serves the old one from its HTTP cache. Stop the window, remove its
  profile's `Default/Cache`, `Default/Code Cache` and `Default/Service Worker`
  and relaunch on the same origin: the pairing (IndexedDB) survives. Check
  the loaded `TerminalRoute-<hash>.js` against the export before a shot.
- The lab's branch row shows the fake Herdr's `/tmp/...` folder, cut with an
  ellipsis at 135 px, and `pwa-check` flags it as clipped. That row is lab
  data on main as well, not this layout.
- `pwa-check` reports `text over text: "" under DIV ""` on every cell, main
  and 393 px included: an empty node inside the terminal, not a painted
  overlap.
- A typed draft at 135 x 297 grows the field to its maximum and leaves no room
  for the terminal; the keyboard would cover it on a phone anyway.
