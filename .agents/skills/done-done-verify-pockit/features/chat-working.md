# Stay in the chat while the agent works, and answer it there

Chat slice 2 (Claude and Pi). Three things the person no longer has to open the
terminal for.

## Sub-features

- `chat-running-strip` while the agent works, a card above the composer says
  `Working · <task>` and, in a small mono inset under it, the last two lines of
  the agent's own screen (`useRunningStrip.ts`, `runningStrip.ts`): the newest
  lines that are not a rule, the prompt box or a key hint, with the interrupt
  hint cut. It reads the pane with the passive `pane.read` every 1.5 s, only
  while the chat is in front and the agent is working, so no host call is new.
  The lines change as the screen does and the card is gone when the agent stops;
  an agent that stops with nothing on screen leaves just the status.
- `chat-helper-card` a helper (Claude's `Task` / `Agent` call) that came back is
  its own card in the reply, not a step in the row: its task title, a status line
  (`7 steps · 1 min 12 s`, or `Failed`) and one line of its answer. `chat.read`
  carries it as the additive `ChatTool.result` (the first non-heading line of the
  helper's answer, 200 characters at most) and the status line in `note`
  (`chatMessages.ts`, from Claude's `toolUseResult`). An older host sends no
  `result`, so its helpers stay steps.
- `chat-ask-answer` a blocked agent with a question on screen shows
  `<Agent> needs you`, the lines above its choices, and each choice as a 44 dp
  button (`ChatWorking.tsx` `AskCard`). A tap types the choice's number, or the
  arrow presses and Enter that reach it, through the terminal's own channel
  (`usePendingChoices`, shared with the terminal's answer chips: same
  `pendingChoices()`, same passive `pane.read`, no new call and no second
  channel). Long questions scroll inside the card; `Open terminal` stays under
  it. While the chat is in front the terminal's chips stand down, so one
  question is never offered twice. With no choices to read (or a view-only
  device) the old needs-you card with Open terminal stays.

## Driving it

`chatWorkingPwaLab.sh` drives the installed PWA through the chat fake lab
(`CHAT_LAB_HELPER=1` seeds a helper's reply; `output <text>` sets what the
pane's screen reads back, `status <state> <task>` its lifecycle): helper card,
working with two lines, the lines changing, blocked on a question with three
choices, one tap, and stopped with no output, at 360/390/445/270 (font 1.0 and
2.0) and 1280/1440, dark and light. The real agent runs (a real Pi on the local
Ollama endpoint through `chatRealAgentLab.mjs`) show the strip from Pi's real
screen.
