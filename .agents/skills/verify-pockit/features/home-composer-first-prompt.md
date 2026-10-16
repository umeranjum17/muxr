# The Home composer's prompt reaches the agent it starts

Sending a prompt from Home's composer starts a new agent and delivers the first
prompt once the agent is ready; if it cannot, the text returns to both Home's
composer and the agent's input without replacing a newer Home draft. Home is
busy only until spawn finishes, not while delivery waits. The agent's screen
opens as soon as the agent exists and shows `Prompt queued` beside the pane tabs
until the agent has taken it; its Send and command ring cannot send ahead of
it. The host waits for the agent to be promptable and for its screen to hold
still, types the prompt once and waits for Herdr's receipt that it started a
turn (`deliverFirstPrompt` in `apps/host/src/agent/infrastructure/herdrSessionSource.ts`).

## Sub-features

- `first-prompt-delivered` a prompt sent from Home is visible in the real new
  agent's TUI, with no second send (checked on OpenCode). A provider quota error
  after delivery is recorded separately, not mistaken for a delivery failure.
- `first-prompt-shell-guard` Shell with a prompt does not spawn or send it:
  Home keeps the text and explains to choose an agent or start Shell without it.
- `first-prompt-queued` the agent screen opens at once and shows `Prompt queued`
  (accessibility label `Prompt queued until the agent is ready`) until the
  agent starts its turn; the chip sits in the pane-tabs row, so the terminal
  does not re-attach when it goes.
- `first-prompt-once` a prompt is typed once; a prompt the agent drops is
  reported as not sent, never typed again.
- `first-prompt-failed` a prompt the agent never takes comes back into Home's
  composer and the agent's draft, with the error alert, even after returning Home.
- `first-prompt-failed-attachments` a failed first prompt's attachments come
  back into the agent composer with its text, in order: a file the host already
  saved returns as a ready chip whose send reuses that saved path (no second
  upload); one never saved uploads again from the agent screen. Home's dock
  shows its own picker's files, so Home gets the text back but not the chips.
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
config. Delivery proof does not need a successful model reply: seeing the
prompt in the real Go TUI qualifies delivery even if Go then reports exhausted
quota. Another model or a stub cannot substitute for that real receipt.

1. Start the lab with a shell pane in a project folder so Home offers that
   folder, pair the device (the native offer from the host's `pair.sock`, as in
   `terminalLatestLab.mjs`), and record the screen.
2. First pick Shell and try a prompt. Confirm no session.start/session.prompt
   reaches the lab, the text stays in Home, and the plain reason is visible.
   Then pick OpenCode, type a unique diagnostic prompt and send once.
3. Poll the lab's panes with `pane read --source visible`: record when that exact
   prompt appears in OpenCode's TUI. Capture the queued state and the real
   delivered text/model line; record any later Go quota error honestly.
4. Go back to Home as soon as the agent opens. Confirm its composer is free
   while delivery remains pending. For failure, stop only this lab agent before
   delivery through the guarded lab helper. Confirm the failed text returns on
   Home, then reopen the agent and confirm its draft also contains it. Keep any
   text entered on Home since spawn. Capture both screens and a short recording.
5. Capture the installed PWA at 270 and 393 dp in light and dark. Also capture
   one native 270 dp / font-scale 2.0 cell for draft retention and Shell's guard.
   Run the skill's Visual check; repeat on the exact published candidate head.
   A delivered prompt followed by a quota error is not a successful reply.

For `first-prompt-failed-attachments`, attach one image on Home and break the
route, not the agent: killing or `SIGSTOP`ping the agent retires its route (the
shell takes the pane back) and the agent screen moves to that shell, so there is
no agent composer left to restore into. Instead, once the attachment file lands
under the lab host's `attachments/<session>/`, `kill -STOP` the lab's own relay
PID (the `apps/relay/dist/main.js` child of the lab process), wait for the
75 s `Your computer didn't answer in time.` alert, then `kill -CONT` it. The
agent screen keeps its route; after the fix it shows the text and the image
chip, and sending it puts the first attempt's saved path in the real TUI.
A PWA picker is fed by intercepting the page's file `<input>` click and setting
its `files`; `chrome-devtools-axi upload` does not reach it.

## Gotchas

- Choose OpenCode explicitly in Home's agent picker and verify the host's
  start snapshot says `agentKind: opencode`. Adding an OpenCode plan account
  does not auto-select it: its catalog sign-in state is unknown. Older builds
  sent a Shell first prompt and failed with `Agent is not ready yet`; that was
  not an OpenCode crash. Current builds refuse it before spawning/sending.
- Do not enlarge the reference viewport to hide a 270 dp failure. Record the
  private OpenCode version and the exact terminal grid when diagnosing it.
- A prompt sent seconds after OpenCode reports idle is the case that drops; a
  slow emulator or a second prompt from the agent screen hides the bug.
- Codex in a lab HOME needs a working `node` on the lab PATH, or it never
  starts and nothing is delivered for an unrelated reason.
