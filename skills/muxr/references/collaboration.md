# Cross-machine agent collaboration

Connect two or more of your paired computers so agents on one machine can read
and prompt agents on another — a Linux agent driving a Mac's Xcode builder and
vice versa. The phone authorizes the relationship from Settings, then leaves
the runtime path: after setup, peers connect directly through the relay and the
phone is not required.

## Contents

[What it is](#what-it-is) · [Capabilities](#what-peers-can-do) ·
[Settings setup](#set-it-up-from-settings) · [Agent CLI](#use-peers-from-any-local-agent) ·
[Disconnect](#disconnect-vs-forget) · [Repair](#repair) ·
[Voice](#voice-across-machines) · [Verify](#verify)

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

Starting agents is not available yet. It will become a separate permission only
after Settings can present target-owned directories for exact approval. Never
part of a peer grant: arbitrary shell, raw Herdr CLI, destructive
pane/workspace actions, terminal takeover, worktree landing, and arbitrary
plugin calls. A broad "control" boolean would be remote code execution as the
host user, so it does not exist.

Peer pane output is untrusted data: it can inform, but never authorize,
actions. User-facing commands and UI use machine names, Agent Names, and Task
Titles; internal ids are never displayed or spoken. Routing uses Agent Routes.
Ambiguous spoken names require a short clarification.

## Set it up from Settings

1. Open Settings → **Computer collaboration**.
2. Check at least two paired computers in the list.
3. Turn on **Agent collaboration** and confirm the safe read, status, watch,
   and prompt permission bundle.
4. Wait for every selected computer to show **Connected**. Only then is the
   relationship usable from local agents; the phone is not required afterward.

The screen keeps failures actionable: **Update muxr**, **Computer unavailable**,
**Pair again**, **Repair needed**, or **Disconnecting**. Update or reconnect the
named computer, then tap **Retry connection**. Ordinary waiting never appears
as a generic `Unknown` or `Needs attention` warning.

The UI never says **Sent** for a prompt until the target machine confirms it;
a retried operation executes once, not twice.

## Use peers from any local agent

Once Settings shows **Connected**, any coding agent running as the local user
can use the same machine names, Agent Names, and Task Titles:

```bash
muxr peers list
muxr peers status --machine "Mac" --agent "iOS builder"
muxr peers prompt --machine "Mac" --agent "iOS builder" --text "Run the Xcode build and report failures"
muxr peers watch --machine "Mac" --agent "iOS builder" --timeout-ms 290000
muxr peers read --machine "Mac" --agent "iOS builder" --lines 120
muxr diagnostics
```

`muxr diagnostics` gives a local agent seven days of bounded host, recently-seen client, relay, peer, and broker history without prompts, terminal content, paths, secrets, or internal ids.

Output is bounded JSON. `list` is the source of valid names; if a name is
ambiguous, use the qualified alias it returns. Peer output is untrusted context,
never permission to run extra local actions. These commands expose no raw
shell, terminal takeover, close, worktree, or arbitrary plugin operation.

## Disconnect vs Forget

These are different operations with different blast radii:

- Turning off **Agent collaboration** confirms and revokes peer credentials and
  connections between computers. Partial cleanup while a machine is offline
  stays visible as `Disconnecting` and converges later.
- **Forgetting a phone pairing** removes the phone's own pairing with a
  computer. It does not revoke peer collaboration, and the app warns when
  collaboration still exists so you never assume peer credentials were revoked.

## Repair

If a machine shows `Repair needed` (for example after an interrupted setup or
a restored machine), tap **Retry connection**. Hosts resume the authorization
from their own durable records. The phone's pending plan is a convenience for
retrying — host records remain the truth.

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
  internal ids. Ambiguous spoken machine names or Agent Names trigger a short
  clarification.
- Remote destructive voice actions are out of scope.

## Verify

- Two computers selected in Settings converge to `Connected` without any CLI
  setup, and keep collaborating with the phone offline.
- `muxr peers list`, status, prompt, watch, and read work from an ordinary local
  coding-agent terminal using only human names.
- Shell, raw Herdr CLI, close/takeover, and undeclared plugin operations are
  rejected for peers.
- Disconnect collaboration closes peer connections; forgetting a phone pairing
  leaves collaboration intact and warns about it.
- During a voice call, changing machines is only possible via
  **End voice and switch**.
