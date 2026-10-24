# A sent prompt says it is on its way, then that it arrived

Tapping Send in an agent's prompt field used to clear the field and show
nothing until the text appeared in the terminal, so a slow send looked like a
lost one. Now the tap is felt (a light haptic, the button's press scale) and
the row under the terminal shows `Sending` until the host confirms Herdr typed
the text into the pane, then `Sent` for a moment. A send the host refuses puts
the text back in the field, shows `Send failed` with the cause and Retry, and
leaves a `Not sent` chip whose tap sends again.

The host also stopped re-reading the whole Herdr tree around a prompt
(`resolvePane` and the confirmation in `promptSession`,
`apps/host/src/agent/infrastructure/herdrSessionSource.ts`): it routes on the
kit's live tree, and skips the confirming read for an agent that publishes no
conversation. Herdr's own `agent.prompt` (300-400 ms) is the rest.

## Sub-features

- `send-pending` the chip reads `Sending` from the tap until the host answers.
- `send-delivered` it turns to `Sent` with a check when the host confirms, then
  fades; the text is in the real pane.
- `send-refused` a send the agent cannot take: the text returns to the field,
  `Send failed` names the cause with Retry, and `Not sent` stays in the row.
- `send-retry` a tap on `Not sent` (or Retry) sends the returned text; it
  reaches the pane once.
- `send-latency` tap-to-confirm and tap-to-echo p50/p95 from the lab link,
  idle, mid-turn, beside busy agents and in a retitling fleet.

## How to get to it (user POV)

Home -> open an agent -> type in the prompt field -> Send.

## Driving it with the private stack

Both labs run inside a Herdr lab you provisioned through the guarded helper
(`HERDR_LAB_HELPER`, `HERDR_LAB_SESSION`, `HERDR_LAB_PREPROVISIONED=1`,
`FM_HERDR_LAB_STATE_DIR`), after `yarn build`. Every model is `labStub.mjs`, so
no account is involved; Claude Code runs in the lab's own HOME.

Latency (`send-latency` journey): from the repo root,
`EVIDENCE=<dir> node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/sendLatencyLab.mjs)"`.
It opens the agent's terminal stream on the link the way the agent screen
does, sends `SENDS` prompts per phase (`PHASES`, default
`idle,working,busy,fleet`; `BUSY` streaming agents, `FLEET` retitling
workspaces) and writes `send-latency.json` with each sample and p50/p95/max of
`confirmMs` (the `session.prompt` answer) and `echoMs` (the text in the
stream). Run it once on main's host build and once on the candidate's.

Native (`send-feedback` journey):
`node .agents/skills/done-done-verify-pockit/features/sendFeedbackNativeLab.mjs <apk> <evidence> <labRoot>`
under the shared emulator lock with a release APK of the commit. At 390 dp dark
it records `send-delivered.mp4` (and a 4x slow copy), makes the agent not ready
(`herdr pane report-agent … --state unknown`), sends, and captures
`02-sending-while-agent-not-ready`, `03-send-failed-alert` and
`04-not-sent-chip-draft-back`; then reports it idle again, taps the chip and
records `send-retry.mp4`. `lab-pane-after.txt` must hold the retried text.

## Gotchas

- The google_apis emulator image runs Play's verifier on every adb install; the
  lab turns it off first, or this release APK's install stalls past 10 min.

- `agent.prompt` types the text before it presses Enter, so the echo lands
  before the confirmation; the chip waits for the confirmation on purpose.
- A not-ready agent is held by the host for up to 40 s before it refuses, so
  `Sending` stays that long in the refused case.
- A lab Claude publishes no conversation id, so its prompts take the
  pane-only path; an agent that publishes one keeps the confirming read when
  Herdr's receipt does not name it.
