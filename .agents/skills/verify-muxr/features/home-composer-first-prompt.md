# The Home composer's prompt reaches the agent it starts

Sending a prompt from Home's composer starts a new agent and delivers the first
prompt once the agent is ready; if it cannot, the text returns to the agent's
input marked not sent. The agent's screen opens as soon as the agent exists and
shows `Prompt queued` beside the pane tabs until the agent has taken it; its own
Send waits until then. The host waits for the agent to be promptable and for its
screen to hold still, types the prompt once and waits for Herdr's receipt that
it started a turn
(`deliverFirstPrompt` in `apps/host/src/agent/infrastructure/herdrSessionSource.ts`).

## Sub-features

- `first-prompt-delivered` a prompt sent from Home is typed once the new agent
  is ready and the agent answers it, with no second send (checked on OpenCode).
- `first-prompt-queued` the agent screen opens at once and shows `Prompt queued`
  (accessibility label `Prompt queued until the agent is ready`) until the
  agent starts its turn; the chip sits in the pane-tabs row, so the terminal
  does not re-attach when it goes.
- `first-prompt-once` a prompt is typed once; a prompt the agent drops is
  reported as not sent, never typed again.
- `first-prompt-failed` a prompt the agent never takes comes back into the
  agent's composer, with the error alert.

## How to get to it (user POV)

Home -> type into `Ask <agent>` -> send. The new agent's screen opens.

## Driving it with the private stack

Preconditions: a release APK from `node perf/buildPrApk.mjs <out>` on a
task-owned emulator under the emulator lock, a real Herdr lab
(`HERDR_LAB_HELPER`, `FM_HERDR_LAB_STATE_DIR`) driven through
`linkHerdrLab`, and OpenCode on PATH. For a real reply, the lab's own
OpenCode store (`<xdg-root>/data/opencode/auth.json`) holds the account's key,
written from a key file and never printed, with
`<xdg-root>/config/opencode/opencode.json` naming the model; otherwise point
OpenCode at `labStub.mjs` as in `terminal-latest.md`.

1. Start the lab with a shell pane in a project folder so Home offers that
   folder, pair the device (the native offer from the host's `pair.sock`, as in
   `terminalLatestLab.mjs`), and record the screen.
2. On Home pick OpenCode, type a prompt with a checkable answer (`Say the word
   pelican backwards in capital letters, nothing else.`) and send.
3. Poll the lab's panes with `pane read --source visible`: time when the prompt
   shows in the OpenCode pane and when `NACILEP` arrives. Capture the agent
   screen with `Prompt queued`, then with the reply and the model line.
4. On main the prompt never shows in the pane (OpenCode's input stays empty);
   on the candidate it shows within seconds and the reply follows.

## Gotchas

- OpenCode crashes when the phone grid shrinks at the 270 dp reference size
  until its keyboard fix lands; drive it at the AVD's 412 dp with the soft
  keyboard disabled (`pm disable-user --user 0 com.google.android.inputmethod.latin`).
- A prompt sent seconds after OpenCode reports idle is the case that drops; a
  slow emulator or a second prompt from the agent screen hides the bug.
- Codex in a lab HOME needs a working `node` on the lab PATH, or it never
  starts and nothing is delivered for an unrelated reason.
