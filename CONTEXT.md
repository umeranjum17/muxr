# muxr

muxr lets a person direct coding agents running on their computers. Human-facing identity, lifecycle reporting, proactive voice, and realtime conversation remain separate from internal routing and provider mechanics.

## Agents

**Agent**:
A coding-agent session muxr tracks. It is the person-shaped row in the herd, not a pane, process, or provider binary.
_Avoid_: pane, tab, process, session row

**Herd**:
The collection of Agents a person directs from the phone or desk.
_Avoid_: session list, inbox, catalog

**Machine**:
A paired computer running herdr. Used to spawn Agents and open terminals.
_Avoid_: host, device, computer (except spoken copy)

**Worktree**:
An isolated checkout herdr creates so Agents can work in parallel on one repo.
_Avoid_: branch folder, clone

**Human Name**:
The spoken first name of an Agent (John, Maria). Secondary, display-only, never a routing key.
_Avoid_: label, animal name, agent name, display label

**Task Title**:
The work the Agent is doing. Primary identity for humans scanning a herd.
_Avoid_: label, pane title, terminal title, name

**Provider Kind**:
Which coding-agent program is running (pi, claude, codex). Separate from Human Name and Task Title.
_Avoid_: agent name, kind label, model

**Agent Route**:
The stable internal route that identifies an Agent across pane moves. The only key used to prompt, watch, or focus. On mobile that route is the host session id.
_Avoid_: pane id, spoken name, label, Herdr agent name

**Lifecycle Event**:
A host-emitted change in an Agent's working, blocked, done, or failed state, keyed by Agent Route.
_Avoid_: status tick, attention row, watch receipt

**Agent Watch**:
The machine-scoped record of Lifecycle Events and the human-visible reports that follow from them.
_Avoid_: inbox, notification store, voice queue, catalog cache

**Voice Report**:
A spoken update about a trusted Agent and Task Title, admitted only after current-schema validation.
_Avoid_: TTS job, announcement, completion chime

## Realtime voice

**Realtime Playback**:
The native PCM sink for one voice call, including admission, backpressure, turn-finish drain, and ownership of drain acknowledgements.
_Avoid_: player, output buffer, audio service

**Stream Generation**:
The owner of audio currently draining. A replacement stream is a new generation and must not receive acknowledgements for previous audio.
_Avoid_: epoch, reconnect id, session id

**Output Drain**:
The ordered wait until native playback of admitted PCM has finished, before queued speech or a connected status for that turn may proceed.
_Avoid_: flush, complete, EOS

## Mobile application

**Spawn**:
Starting one Agent or a squad on a Machine, in a directory, optionally on a Worktree.
_Avoid_: new session, create chat

**Dock**:
Home chrome that picks Machine, project path, Worktree, and Provider Kind for the next Spawn.
_Avoid_: composer, launcher, FAB sheet

**Terminal Link**:
A URL an Agent printed. Loopback HTML can open as Preview; the rest opens outside the app.
_Avoid_: chip URL, detected hyperlink

**Collaboration**:
The intended mesh of paired Machines that can reach each other. Machine ids authorize; computer names never do.
_Avoid_: peer graph, computer sharing

## Hosted pairing

**Pairing String**:
The URL a person pastes or scans to bind this device to a machine. Distinct from account login.
_Avoid_: claim, ticket, QR payload

**Hosted Grant**:
The verified machine permission this device stores after pairing. It owns authority, the relay, and the keys used to open sealed traffic.
_Avoid_: token, pairing cache, device record

**Device Authority**:
Control or observe permission stored on the Hosted Grant. Comes from the Pairing String, never from a machine display name.
_Avoid_: role, browser flag

**Connection**:
Hosted (grant-backed) or local (dev fixture) reachability for one machine id.
_Avoid_: settings blob, relay config

**Account Credential**:
Proof of the person's muxr account. Independent of any Hosted Grant.
_Avoid_: token, pairing, device grant

**Mic Ownership**:
The exclusive claim among the realtime call, dictation, and VAD standby.
_Avoid_: audio focus, recorder lock

## Setup and plugins

**Bundled Plugin**:
A Herdr plugin folder shipped with muxr and linked during setup. Optional provider adapters stay disabled until chosen.
_Avoid_: extension, package, add-on

**Coordinator Policy**:
The spoken-name, coding-tool, and redaction rules every realtime voice adapter must follow.
_Avoid_: prompt, system prompt, provider policy

**Ingress**:
The published path phones use to reach a Self-host relay: Tailscale Serve, a Cloudflare tunnel, or an external reverse proxy.
_Avoid_: tunnel, proxy, advertise URL

**Self-host**:
A machine-owned relay and pairing authority, as opposed to the hosted cloud control plane.
_Avoid_: local mode, selfhost.json, standalone
