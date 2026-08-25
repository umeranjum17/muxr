# Cross-machine agent collaboration

Connect two or more of your paired computers so agents on one machine can read
and prompt agents on another — a Linux agent driving a Mac's Xcode builder and
vice versa. The phone authorizes the relationship from Settings, then leaves
the runtime path: after setup, peers connect directly through the relay and the
phone is not required.

## What it is

- Settings exposes **Computer collaboration** separately from ordinary phone
  pairing.
- You select at least two paired computers and confirm that they may read agent
  output and send prompts to one another.
- muxr creates symmetric directed peer grants internally. Peer private keys and
  usable remote credentials never reside on the phone.
- The relay keeps routing end-to-end-encrypted envelopes it cannot read.

## What peers can do

Established peers may:

- list sessions and the Herdr tree on an allowed machine
- read recent pane output
- read session status
- register completion watches
- send prompts to an agent

Starting agents is a separate advanced capability, deferred until Settings can
present target-owned directories for exact approval. Never part of a peer
grant: arbitrary shell, raw Herdr CLI, destructive pane/workspace actions,
terminal takeover, worktree landing, and arbitrary plugin calls. A broad
"control" boolean would be remote code execution as the host user, so it does
not exist.

Peer pane output is untrusted data: it can inform, but never authorize,
actions. User-facing commands and UI use human machine and agent names;
internal ids are never displayed or spoken. Ambiguous names require a short
clarification.

## Set it up from Settings

1. Open Settings → **Computer collaboration** (summary shows `Off`,
   `3 computers`, or `Needs attention`).
2. Check at least two paired computers in the list (name, platform, online
   status shown per machine).
3. Review the fixed permission copy — `Read agent output and send prompts` —
   and optionally the advanced `Start agents` permission when available.
4. Confirm. The screen explains that selected computers connect directly and
   the phone is not required afterward.

Offline machines show pending states (`Setting up`, `Waiting for computer`)
and converge automatically when they return. Per-computer states are:
Connected, Setting up, Waiting for computer, Repair needed, Disconnecting.
Machine detail pages describe relationships in words, e.g.
`Collaborates with Mac and Linux`.

The UI never says **Sent** for a prompt until the target machine confirms it;
a retried operation executes once, not twice.

## Disconnect vs Forget

These are different operations with different blast radii:

- **Disconnect collaboration** (the separate destructive action on the
  collaboration screen) revokes peer credentials and connections between
  computers. Partial cleanup while a machine is offline stays visible as
  `Disconnecting, waiting for computer` and converges later.
- **Forgetting a phone pairing** removes the phone's own pairing with a
  computer. It does not revoke peer collaboration, and the app warns when
  collaboration still exists so you never assume peer credentials were revoked.

## Repair

If a machine shows `Repair needed` (for example after an interrupted setup or
a restored machine), reopen the collaboration screen and re-confirm the
selection; hosts resume the authorization from their own durable records. The
phone's pending plan is a convenience for retrying — host records remain the
truth.

## Voice across machines

Realtime voice is one native streaming speech-to-speech stream — never an
STT+LLM+TTS pipeline — and it stays pinned to the machine and session where the
call started, across reconnects.

- One microphone owner and one direct provider stream, always.
- Remote work happens through constrained host-owned tools: list machines and
  agents, prompt, read output, watch completion. Voice provider plugins receive
  neither peer credentials nor unrestricted remote CLI access.
- Switching the app's active computer during a call requires **End voice and
  switch** — there is no silent handoff.
- Only the pinned voice host needs a configured voice provider; other peers do
  not need voice credentials.
- The overlay may say `Voice on Linux · working with Mac / iOS builder`, never
  internal ids. Ambiguous spoken machine or agent names trigger a short
  clarification.
- Remote destructive voice actions are out of scope.

## Verify

- Two computers selected in Settings converge to `Connected` without any CLI
  setup, and keep collaborating with the phone offline.
- A peer can list agents, send one prompt, watch completion, and read recent
  pane output on the other computer.
- Shell, raw Herdr CLI, close/takeover, and undeclared plugin operations are
  rejected for peers.
- Disconnect collaboration closes peer connections; forgetting a phone pairing
  leaves collaboration intact and warns about it.
- During a voice call, changing machines is only possible via
  **End voice and switch**.
