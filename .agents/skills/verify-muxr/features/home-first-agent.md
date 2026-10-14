# Start the first agent from Home in one tap

A newcomer with no agents yet sees Home's "Start your first agent" card. When a
real agent (never Shell) is ready on the connected computer — installed and
signed in, per the host's `herdr.agentKinds` readiness, with Pi never the
automatic choice — the card's primary button reads `Start <agent>` and starts
it straight away in the last folder (else `~`), with no picker. When none is
ready it says in one plain sentence what to do for the best candidate (sign in
on the computer, choose the installed one, or install one), keeps `Check again`
for the steps the computer must finish, and keeps the full picker one tap away.
The offer is `firstAgentOffer` in `apps/mobile/sources/spawn/application/homeDockEnvironment.ts`;
the card is `FirstAgentCard` in `apps/mobile/sources/herd/presentation/HomeFirstRunCards.tsx`.

## Sub-features

- `one-tap-start` a signed-in Claude Code (or Codex) makes the card read
  `Claude Code is ready on your computer.` with `Start Claude Code`; one tap
  opens the new agent's screen and the card retires (Home now has an agent).
- `sign-in-step` an installed but signed-out agent reads `Sign in to Claude
  Code on your computer, then tap Check again.`; after signing in on the
  computer, `Check again` turns the card into `Start Claude Code` in place.
- `choose-step` an installed agent other than Pi whose sign-in cannot be checked
  (OpenCode, …) reads `Choose <agent> to start it, and sign in on your computer
  if it asks.` A computer whose only installed agent is Pi gets the plain
  invitation with a `Start an agent` button and never names Pi.
- `install-step` no coding agent at all reads `Install a coding agent such as
  Claude Code on your computer, then tap Check again.`
- `picker-one-tap` `Agents` (beside `Start <agent>`) / `Choose an agent` opens
  the picker and does not retire the card; only `Not now` or a started agent
  does. `Agents` stays on one line at 270 dp and font 2.0, native and PWA.
- `start-error` a failed start shows the real cause under the sentence and
  retires the one-tap `Start` for the rest of the card's life: the card offers
  `Open agents` (the picker) and `Check again`, never a second `Start`. A failed
  `Check again` says the computer could not be reached. A failed read on mount
  does the same, with `Check again` to retry in place.

## How to get to it (user POV)

Pair a computer that has no agents running yet and open Home. The first card
is "Start your first agent". Its button names the agent that is ready, or its
sentence says what to do on the computer.

## Driving it with the private stack

Preconditions: a release APK built from the candidate (`perf/buildPrApk.mjs`;
add `arm64-v8a` to `-PreactNativeArchitectures` for a real phone) and the
fake-Herdr stack (`perf/lib/fakeStack.mjs`) started with `panes: 0, agents: 0`
so Home has no agents, a `claude` stand-in as the only agent on the host's
`PATH` (`PATH=<lab-bin>:<node dir>:/usr/bin:/bin`; the stand-in answers
`claude auth status` with `{"loggedIn":true}` only while
`$HOME/.claude/lab-account.json` exists — the same stand-in as the accounts
lab), and `MUXR_MACHINE_NAME=Umer`. Mint a native offer with the stack's
`mintPairing()` (it auto-approves the words) and deliver it with
`adb -s "$SERIAL" reverse tcp:<relay> tcp:<relay>` plus typing it into
"Type the pairing code" (30-character `adb shell input text` chunks).

1. Signed out (no `lab-account.json`): open Home, assert the sign-in sentence and
   `Check again` + `Choose an agent`; no `Start …` button. Capture.
2. Write `lab-account.json` (`{"loggedIn":true}`) and tap `Check again`; assert
   `Start Claude Code` appears without leaving Home. Capture.
3. Tap `Start Claude Code`; assert the agent screen opens with no picker in
   between, and the host log shows one `session.start` with `kind: claude`.
   Back on Home the card is gone and the agent's row is there. Capture.
4. Time the step from Home to the open agent with timestamped screenshots
   (`adb exec-out screencap -p` every ~0.5 s, joined with ffmpeg) on main and
   on the candidate; main goes through the picker (`Start an agent` → picker →
   select → Start).
5. Installed PWA: serve the lab-flag export (`lab-browser-pairing.md`), pair it
   with a browser link from the same stack, and capture the card in each state
   at 393 and 270 px, light and dark.

## Gotchas

- Fresh app data is needed to see the card: it is retired for good once
  dismissed or once any agent existed. Use a fresh install or a fresh browser
  profile, never a hand-edited setting.
- The host caches the catalog for 30 s; the card's `Check again` asks for a
  fresh read (`refresh: true`), so toggle the stand-in and tap it rather than
  waiting.
- The fake Herdr's `agent.start` only records the agent; the pane is a plain
  shell. That proves the one-tap start path, not the agent CLI itself.
