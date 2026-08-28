# muxr

muxr lets a person direct coding agents running on their computers. User-facing identity, lifecycle reporting, proactive voice, and realtime conversation remain separate from internal routing and provider mechanics.

## Machines

**Machine**:
A computer whose Agents a person directs. Distinct from the phone, browser, or peer that holds a Device Grant to it.
_Avoid_: host box, node, computer

**Device Grant**:
Keyed admission a phone, browser, or peer holds to a Machine.
_Avoid_: client token, paired device

**Peer Identity**:
Who a socket is after admission: ticket-backed or loopback. Agent Route still authorizes Agents; Peer Identity authorizes the wire.
_Avoid_: client token, legacy identity, account token

**Ticket**:
Short-lived proof that mints a WebSocket. Presence of transport means ticket admission.
_Avoid_: session cookie, API key, machine token

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

**Agent Name**:
The user-editable Herdr `agent.name` (`falcon`, `reviewer`). Display-only, never a routing key.
_Avoid_: label, display label, pane title

**Task Title**:
The work the Agent is doing. Primary identity for people scanning a herd.
_Avoid_: label, pane title, terminal title, name

**Provider Kind**:
Which coding-agent program is running (pi, claude, codex). Separate from Agent Name and Task Title.
_Avoid_: agent name, kind label, model

**Agent Route**:
The stable internal route that identifies an Agent across pane moves. The only key used to prompt, watch, or focus. On mobile that route is the host session id.
_Avoid_: pane id, spoken name, label, Herdr agent name

**Lifecycle Event**:
A host-emitted change in an Agent's working, blocked, done, or failed state, keyed by Agent Route.
_Avoid_: status tick, attention row, watch receipt

**Agent Watch**:
The machine-scoped record of Lifecycle Events and the user-visible reports that follow from them.
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

**Machine**:
The computer running muxr, identified by a stable Machine Id derived from its key material. Display names never identify it.
_Avoid_: host, node, box, computer name

**Machine Id**:
The durable identifier of a Machine. The only key used to enroll, revoke, or publish grants for that computer.
_Avoid_: hostname, machine name, slug label

**Device Id**:
The durable identifier of a paired phone or browser. The only key that authorizes a grant, revocation, or rotation.
_Avoid_: device name, phone name, display name

**Device Authority**:
Whether a paired Device may control agents (`control`) or only watch (`observe`). Native pairings are always control.
_Avoid_: role, permission, access level

**Client Kind**:
Whether the paired client is the native app or a browser. Browser grants last eight hours; native grants are durable.
_Avoid_: platform, client type, device type

**Pairing Intent**:
The decision to mint a grant for a Client Kind and Device Authority, including lifetime and the locator the client opens.
_Avoid_: pairing flags, --browser, QR options

**Enrollment**:
A one-time claim a Machine presents to join a shared Self-host relay. It is not a Device grant.
_Avoid_: invite, join code, pairing string

**Connection**:
How phones reach this Machine's relay: mode, location, role, advertised URL, and whether browser hosting is allowed.
_Avoid_: network settings, advertise bag, selfhost state

**Plugin Id**:
The stable identity of a bundled or installed plugin. Folder names are filesystem paths only.
_Avoid_: plugin folder, plugin name, package name

**Provider Secret**:
An owner-only API key for a realtime voice provider, stored under ~/.muxr. Display labels never authorize it.
_Avoid_: API key file, settings key, voice credential

Named application operations for mobile UI and runtime live in
[apps/mobile/sources/USE_CASES.md](apps/mobile/sources/USE_CASES.md).
