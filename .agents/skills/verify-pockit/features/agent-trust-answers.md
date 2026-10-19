# Answer an agent's folder-trust question in one tap

When an agent asks a question whose choices carry no numbers, such as Claude
Code's "Is this a project you created or one you trust?" with `❯ No, exit`
highlighted, the terminal shows each choice as a one-tap answer above the
composer, the same band as numbered prompts. A tap moves from the highlighted
row to the tapped one and presses Enter, so trusting the folder never depends
on finding the down key, and Enter alone (which exits) is never the answer.
Both start points (Home's Start and New agent) begin in the last folder an
agent started in on that computer, else the folder desktop setup chose there
(see the README), else `~`.

## Sub-features

- The trust question shows `No, exit` and `Yes, I trust this folder` as chips
  with no number badge; tapping `Yes, I trust this folder` reaches the agent's
  banner (or its sign-in line) without any key-row press.
- The question can wait: Herdr keeps the agent launch-pending until it is
  answered, and the launch still counts as started after the host's 60 s
  launch deadline, so the chips stay instead of "Agent could not start".
- Numbered prompts (`❯ 1. Yes / 2. …`) keep their number badge and still type
  the number.
- An agent started from New agent in a folder makes Home's next Start use that
  folder, and a folder picked on Home is what New agent opens on next.

## How to get to it (user POV)

Pair a computer where Claude Code has never trusted the folder. Start Claude
Code from New agent, open it, and answer the trust question from the chips
above the composer.

## Driving it with the private stack

Preconditions: a release APK built from the candidate for the device's ABI
(`perf/buildPrApk.mjs`, with `-PreactNativeArchitectures` set to the device's
ABI, `JAVA_HOME` pointing at a JDK 21) and, for the PWA, the lab-flag web
export of `lab-browser-pairing.md`. Real Herdr is required: the fake stack has
no agent that draws the trust dialog. Use a guarded, non-default Herdr lab
session (`fm-herdr-lab.sh provision`) and run the relay (`MUXR_RELAY_PORT=0`,
port read from its own stdout) and the host (`HERDR_SESSION=<lab>`, no
`--fake`) directly, with `HOME`, `XDG_*` and `CLAUDE_CONFIG_DIR` taken from a
lab pane's own environment so the agent never reads the owner's config. Write
`{"hasCompletedOnboarding":true,"theme":"dark"}` to the lab
`$CLAUDE_CONFIG_DIR/.claude.json` before each run so the folder is untrusted
again; no sign-in is needed, the question comes before it.

1. Pair the device through `node scripts/cli.mjs pair` under a pty
   (`script -qec 'node scripts/cli.mjs pair' /dev/null`; without a TTY it
   refuses), deep link `muxr://pair#<offer>` via `adb shell am start`, with
   `adb reverse tcp:<port> tcp:<port>`. The PWA cannot use `pair --browser`
   on this Wi-Fi-only lab route; mint the browser offer on the lab host's
   `pair.sock` the way `perf/lib/fakeStack.mjs` `mintPairing` does and pass
   it to `window.__MUXR_LAB_PAIR__`.
2. New agent → Claude Code → Start. Open the agent; Herdr's `agent explain`
   reports `state: blocked` (`live_blocked_form`) while the question shows.
3. Capture the chip band, then tap `Yes, I trust this folder` and capture the
   agent's next screen with its timestamp. Time the step from the question
   first painted to the trusted screen; on a build without the chips the same
   step takes the key row's down key and Enter.
4. PWA: leave the question unanswered for over 60 s, then capture the chip
   band at 393 and 270 px, light and dark, and tap `Yes, I trust this folder`.
5. Start folder: start once from New agent in `~/notes-app`; Home's Start now
   reads `notes-app` and its agent's pane cwd (`agent list`) is that folder.

## Gotchas

- Herdr reads the pane at its own width; a choice wider than the grid wraps,
  and an unnumbered wrapped label reads as two rows. Keep the proof at the
  phone's real grid (about 44 columns at 270dp).
- Claude Code never saves trust for the home folder, so an agent in `~` asks
  again on every start; that is Claude Code's rule, not a muxr regression.
- The notifications modal can sit over the first agent; dismiss it before
  timing the trust step.
- The terminal screen is dark in both themes; only the rest of the app follows
  light mode. Emulate the scheme before a reload, the theme is read at load.
- Run the Herdr lab teardown with the caller's own `HOME`/`XDG_*`, not the lab
  pane's: the helper's tripwire reads the fleet with them and refuses otherwise.
