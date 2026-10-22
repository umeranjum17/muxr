# Read a Claude or Pi agent as a chat, and switch it with the terminal

A paired phone can open a Claude or Pi agent as a chat: your messages and the
agent's replies as whole bubbles (Markdown drawn), a running line with the
agent's current task, the model it runs, and the normal composer (attach, mic,
and a stop button while it works). The header's chat and terminal buttons switch
that agent between the two; the terminal stays attached underneath, so
switching never re-attaches the pane. Settings → Session view picks the default
(Terminal, Chat, or Chat on phone). An agent that waits on an approval shows a
`needs you` card whose Open terminal button switches to the terminal, where the
real prompt is answered. The host reads the harness's own session log through
`chat.read` (`apps/host/src/agent/infrastructure/chatTranscript.ts`), found the
way Herdr names it: Claude by session id under the project folder, Pi by the
log path Herdr reports. Codex, OpenCode, tool cards and in-chat approvals are
not part of it.

## Sub-features

- `chat-read` a real Claude and a real Pi log become user/assistant bubbles;
  thinking, tool calls and results, sidechains, slash-command bookkeeping,
  background-task notices and `[Request interrupted by user…]` never do.
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

## Gotchas

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
