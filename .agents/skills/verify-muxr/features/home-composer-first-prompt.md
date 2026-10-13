# The Home composer's prompt reaches the agent it starts

Sending a prompt from Home's composer starts a new agent and delivers the first
prompt once the agent is ready; if it cannot, the text returns to both Home's
composer and the agent's input without replacing a newer Home draft. Home is
busy only until spawn finishes, not while delivery waits. The agent's screen
opens as soon as the agent exists and shows `Prompt queued` beside the pane tabs
until the agent has taken it; its Send and command ring cannot send ahead of it. The host waits for the agent to be promptable and for its
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
- `first-prompt-failed` a prompt the agent never takes comes back into Home's
  composer and the agent's draft, with the error alert, even after returning Home.
- `first-prompt-home-free` go back to Home immediately after spawn: its composer
  accepts a new draft while the first prompt is still queued.
- `first-prompt-ring-held` open the agent's command ring while `Prompt queued`
  is shown: a ring command must not reach the terminal ahead of that prompt.

## How to get to it (user POV)

Home -> type into `Ask <agent>` -> send. The new agent's screen opens.

## Driving it with the private stack

Preconditions: a release APK from `node perf/buildPrApk.mjs <out>` on a
task-owned emulator under the emulator lock, a real Herdr lab
(`HERDR_LAB_HELPER`, `FM_HERDR_LAB_STATE_DIR`) driven through
`linkHerdrLab`, and a task-private OpenCode 2.x on the lab PATH with
`OPENCODE_DISABLE_AUTOUPDATE=1`. For Go Muse, sign in through muxr's published
BYOKit route `opencode:plan_key:opencode-go`; never read or copy a raw key file.
The host selects `opencode-go/muse-spark-1.3-contributor` from that account's
config. An exhausted account pauses the real reply proof; another model or a
stub cannot substitute for it.

1. Start the lab with a shell pane in a project folder so Home offers that
   folder, pair the device (the native offer from the host's `pair.sock`, as in
   `terminalLatestLab.mjs`), and record the screen.
2. On Home pick OpenCode, type a prompt with a checkable answer (`Say the word
   pelican backwards in capital letters, nothing else.`) and send.
3. Poll the lab's panes with `pane read --source visible`: time when the prompt
   shows in the OpenCode pane and when `NACILEP` arrives. Capture the agent
   screen with `Prompt queued`, then with the reply and the model line.
4. Go back to Home as soon as the agent opens. Confirm its composer is free
   while delivery remains pending. For failure, stop only this lab agent before
   delivery through the guarded lab helper. Confirm the failed text returns on
   Home, then reopen the agent and confirm its draft also contains it. Keep any
   text entered on Home since spawn. Capture both screens and a short recording.
5. Run the skill's Visual check on native and installed-PWA captures in light
   and dark at 270 dp, including the largest text size; repeat on the exact
   published candidate head. A quota-paused reply is not a passing reply proof.

## Gotchas

- Choose OpenCode explicitly in Home's agent picker and verify the host's
  start snapshot says `agentKind: opencode`. Adding an OpenCode plan account
  does not auto-select it: its catalog sign-in state is unknown. A Shell
  start followed by `session.prompt` fails with `Agent is not ready yet` and
  is not evidence that an OpenCode process died.
- Do not enlarge the reference viewport to hide a 270 dp failure. Record the
  private OpenCode version and the exact terminal grid when diagnosing it.
- A prompt sent seconds after OpenCode reports idle is the case that drops; a
  slow emulator or a second prompt from the agent screen hides the bug.
- Codex in a lab HOME needs a working `node` on the lab PATH, or it never
  starts and nothing is delivered for an unrelated reason.
