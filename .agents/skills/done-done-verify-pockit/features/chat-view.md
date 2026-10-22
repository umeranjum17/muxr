# Read a Claude or Pi agent as a chat, and switch it with the terminal

A paired phone can open a Claude or Pi agent as a chat: your messages in grey
bubbles on the right, the agent's replies as plain text across the column
(Markdown drawn), the tools each reply used as step rows (an icon per kind and
the real target: `Edited src/checkout/shipping.ts +1 −1`, `Ran yarn test`) that
open in place to a peek, several in one reply folded into one row, a running line with the agent's current task, the
model it runs, and the normal composer ("Reply to Claude", attach, mic, a blue
send, and a stop button while it works). The header reads "‹ Agents", the
agent's status dot and its task; below 340 dp of text width the back is a bare
chevron and the agent name gives way to the task. The header's chat and terminal buttons switch
that agent between the two; the terminal stays attached underneath, so
switching never re-attaches the pane. Settings → Session view picks the default
(Terminal, Chat, or Chat on phone). An agent that waits on an approval shows a
`needs you` card whose Open terminal button switches to the terminal, where the
real prompt is answered. The host reads the harness's own session log through
`chat.read` (`apps/host/src/agent/infrastructure/chatTranscript.ts`), found the
way Herdr names it: Claude by session id under the project folder, Pi by the
log path Herdr reports. Codex, OpenCode, inline images and in-chat approvals
are not part of it.

## Sub-features

- `chat-read` a real Claude and a real Pi log become user bubbles and plain
  replies; thinking, tool results, sidechains, slash-command bookkeeping,
  background-task notices and `[Request interrupted by user…]` never do.
- `chat-tools` each reply's tool calls (Claude `tool_use`, Pi `toolCall`) ride
  on it as steps (`chatMessages.ts` `TOOL_KINDS`, drawn by `ChatSteps.tsx`): one
  grey Octicon per kind, the verb, the target in mono cut in the middle so a
  file's name stays (a path inside the agent's folder reads from there), and
  colour only for meaning (`+N` green, `−N` red, `failed`, a check for a command
  that passed, a spinner for an unanswered call in the newest reply of a working
  agent). One call is its own row; two or more fold into one row ("Edited 1
  file, ran 1 command  +1 −1") that opens in place. A tap on a step peeks in
  place: an edit's first 8 diff lines (numbered from Claude's own
  `toolUseResult.structuredPatch`, from the edit's arguments for Pi) then `Full
  diff ›` (a sheet with every line the host sent, at most 40); a command's last 6
  output lines with `Exit N` and `Open terminal ›`; a search's matches; a read's
  first lines; a plan's checklist. Results are matched to calls by id (Claude
  `tool_result`, Pi `toolResult`). An older host's steps (no `kind`) draw a gear
  and their old words. Every row is a 44 dp target.
- `chat-toggle` the header's chat/terminal pair switches per agent and is
  remembered; an agent without a chat (Codex, OpenCode, a shell) keeps the
  terminal and its chat button dimmed.
- `chat-default` Settings → Session view: Terminal, Chat, Chat on phone; it
  applies to an agent with no choice of its own.
- `chat-running` a working agent shows `Working · <task>` and the composer's
  trailing circle becomes Stop (`session.abort`).
- `chat-needs-you` a blocked agent shows the needs-you card; Open terminal
  switches to the terminal.
- `chat-model` the model pill shows what Herdr's pane metadata (`muxr name`)
  says; absent when none.

## How to get to it (user POV)

Pair the phone, open an agent that has already had its first prompt, tap the
chat button in the header (or set Settings → Session view to Chat). Type in the
composer: the reply arrives as one bubble when the agent finishes it. When the
agent asks for permission the card says so; tap Open terminal and answer there.

## Driving it with the private stack

Preconditions: `yarn build`, and the web export with the lab pairing hook
(`EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export`, see `lab-browser-pairing.md`);
the export server caches files at start, so restart it after a re-export. A
Herdr lab session through the guarded helper (`HERDR_LAB_HELPER`,
`provision`/`run`/`teardown` only; never the default session) with its
`teardown` in the EXIT trap. Real `claude` and `pi` signed in as the person
already is: start them in lab panes with the ambient lab env removed so they run
as installed, e.g. `env -u CLAUDE_CONFIG_DIR -u PI_CODING_AGENT_DIR -u CODEX_HOME -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME HOME=$HOME claude --model <not Fable>`;
Pi takes `--session-dir <lab dir>` so its log lands under the root the host
reads, and Claude's project folder is linked (one folder, never the credential
files) into `CHAT_LAB_CLAUDE_CONFIG/projects/`. Give Herdr's pane the model
label the way `muxr name` does: `herdr pane report-metadata <pane> --source
muxr.naming --token provider=claude --token "model=Sonnet 5.5"` through the helper.

1. Start the stack: `HERDR_LAB_HELPER=… HERDR_LAB_SESSION=… CHAT_LAB_ROOT=<short path under ~/.cache/fms>
   CHAT_LAB_CLAUDE_CONFIG=… CHAT_LAB_PI_DIR=… node .agents/skills/done-done-verify-pockit/features/chatLab.mjs`
   (own pid recorded; stdin `/dev/null`). It prints `lab ready: relay port <p>` and a browser link.
2. Serve the export (`serveWebExport.mjs`, a fixed free port, never 8792), open a
   390 px window (`chrome-devtools-axi`, `--app=… --window-size=390,844`), clear
   the service worker and caches once, then
   `window.__MUXR_LAB_PAIR__(<link>)` within two minutes (SIGUSR1 mints another).
3. Give each agent one first prompt in its terminal (an agent with no task yet
   opens the new-agent screen, not a session), then open it from Home. Chat
   view → type a prompt in the composer → the reply bubble; screenshot the
   working line and Stop while it runs, and the Markdown reply.
4. A Claude started with `--permission-mode default` asked to run a shell
   command goes `blocked`: the needs-you card, then Open terminal shows the real
   prompt. Escape it through the helper's `pane send-keys`.
5. Settings → Session view → Chat; clear `paneViews` in the page's
   `local-settings` and open an agent: it opens as a chat.
6. Judge every screenshot at 390, 270 (594 tall) and 820: no clipped text, no raw
   markup, no home paths, ids, or the person's own data. Stop every pid the run
   started (lab, export server, browser), then the helper's `teardown`.

## Driving it without Herdr (fake stack)

When the task may not drive Herdr, `chatFakeLab.mjs` runs the fake-Herdr stack
(real relay, host and E2EE) with a Claude conversation seeded where the host
reads Claude logs, so `chat.read`, the bubbles and the tool steps are the real
code paths; only the agents are fake (Pi and Claude, both idle). It drops
`CLAUDE_CONFIG_DIR`, the other harness dirs and `XDG_*_HOME` from its env so the
host never finds the person's own logs. Run it from the repo root after
`yarn build`: `node --input-type=module -e "$(< .agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs)"`.
`SIGUSR1` mints a browser link (pair the lab PWA as in step 2 above),
`SIGUSR2` a native one; `CHAT_LAB_SERIAL=<emulator>` makes it reverse the relay
port onto that emulator. Native: install a lab-id release APK (perf/README),
`pm clear` it, open `muxr-dev://pair#<native link>` with an explicit component
and tap Pair; dismiss Home's notification card and scroll before tapping the
Claude row (the Home composer covers the bottom). Open it, tap Chat view; the seeded replies show a read/search group, an
edit+test group and a five-step group whose last command failed. Tap a group to
open it, a step to peek, `Full diff ›` for the sheet, the group again to fold it;
type in the composer for the blue send. Capture at 390 dp
(1080 px at density 443) and 270 dp (density 640), dark and light.

`chatStepsNativeLab.mjs <apk> <evidenceDir> <avdHome>` drives that native recipe
end to end for the tool steps (boot an owned emulator, the fake lab over adb,
pair, then folded / group with edit peek / command peek / full diff at 390 and
270 dp, light and dark, through `visualCheck.mjs`, plus a screen recording of
open, peek and fold). Run it inside the emulator lock: `flock -o -w 3600
/tmp/fm-muxr-emulator.lock timeout 1800 node …/chatStepsNativeLab.mjs …`. The
APK is a lab-id release (`APP_ENV=development MUXR_APP_ID_BASE=app.muxr.chatsteps
MUXR_DEV_APP_ID=app.muxr.chatsteps.dev MUXR_DISTRIBUTION=direct` with
`-PmuxrDevelopmentApp=true`); the journey finds the package by `chatsteps`.

## Gotchas

- The PWA's terminal redraws constantly, so `chrome-devtools-axi` snapshot
  refs go stale before a `click @uid` lands (STALE_REF, easy to miss with output
  hidden). Click the chat controls with an `eval` that finds the on-screen
  element by `aria-label` and calls `.click()`.

- Unistyles keeps each hook's first scope: switching a screen's `ScopedTheme`
  while it is mounted leaves half of it on the old theme. The chat therefore
  lives in the terminal screen's own dark scope in every app theme.
- A Home draft in the composer turns the next tap on an agent into a
  new-agent start; clear it before opening agents from Home.
- Pi's own "Claude rate limit warning" line trips the host's quota-retry
  heuristic (`herdrSessionSource.ts`, quota retry → `blocked`), so a Pi pane can
  read Needs you on a healthy idle agent. That is not the chat's.
- A lab pane's own terminal can show the person's home path or tool warnings:
  keep the chat captures, not terminal shots of a real HOME.
