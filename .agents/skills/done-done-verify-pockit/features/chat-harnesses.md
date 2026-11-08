# Which harnesses get the chat

muxr's chat supports Claude, Pi and Codex. An OpenCode agent opens as a
terminal, and the app says so itself: the header's Chat control is drawn for
every agent but is dimmed and carries the label `Chat view, available for
Claude, Pi and Codex`, and Settings → Session view reads "Claude, Pi and Codex open as a
chat; other agents open the terminal" with the footer "Chat reads Claude, Pi and Codex
sessions only."

The gate is two lines of product code, and it is not a bug in either:

- `agentHasChat()` in `apps/mobile/sources/chat/domain/sessionView.ts` keeps
  a set of `claude`, `pi` and `codex`, and `resolvePaneView()` returns `terminal` for any
  other kind, so the chat view is never entered and `useChat` never asks the
  host for a conversation.
- `harnessOf()` in `apps/host/src/agent/infrastructure/chatTranscript.ts`
  answers `{ state: 'unavailable', reason: 'unsupported-agent' }` for any other
  kind, so even a host asked directly has no reader for an OpenCode session store.

What that means for chat slice 2's three facets (`chat-working.md`), measured
on unsupported harnesses by this feature's lab:

- `chat-running-strip` — not offered. The strip is drawn inside `ChatPane`,
  which is only mounted for an agent with a chat.
- `chat-helper-card` — not offered, for the same reason plus the host gate: the
  helper's card comes from `chat.read`, which has no OpenCode reader.
- `chat-ask-answer` — the in-chat card is not offered, but the capability is not
  lost: a blocked OpenCode pane shows the terminal's own `Answer` chips
  (`PendingChoices`), built from the same `usePendingChoices` and typing through
  the same channel. The lab taps one and reads the number out of the pane's
  input.

## Driving it

`chatHarnessesPwaLab.sh` runs the installed PWA against the chat fake lab with
`CHAT_LAB_PANES=5` (one agent of every kind) and `CHAT_LAB_HELPER=1`, and the
lab's `agent <kind>` line moves the stdin commands onto the harness under test.
Per harness, at phone 390 and desktop 1280 dp, dark and light, it opens the
agent, reads the header's Chat control by its label, presses it, holds the agent
working with two screen lines and then blocked on a three-choice question, and
records whether the chat drew anything (the composer's model chip, the Running
strip, a helper's card) and whether an `Answer` chip appeared. On a harness with
no chat the chip that appears is the terminal's, so it taps one and reads the
pane's input back. It finishes on Settings → Session view and reads the
sentence there.

The cited folder holds the frames a claim is about; the whole width and theme
matrix, `lines.log` and `steps.json` live in `<evidence>-matrix` beside it, so
the judge's capture set stays small. The lab exits 1 when a harness draws a chat
or loses its Chat control or its chip stops reaching the pane — a harness that
gains a chat turns this red instead of quietly passing.

```sh
EXPO_PUBLIC_MUXR_LAB_PAIR=1 yarn web:export
MUXR_LAB_WEB="$PWD/apps/mobile/dist"
CHAT_HARNESS=opencode done-done verify chat-harnesses-pwa --outcome "<claim>" --claim-id <id>:opencode
```

Adding a reader for a third harness means changing both gates above and both of
`features/chat-harnesses.md`'s observations: the lab asserts the terminal-only
behaviour, so it fails first.

Codex is covered by the real-agent journeys in `chat-view.md`, including native
rollout parsing, wrapped Markdown, folded tools, and the terminal fallback.
