# muxr

muxr lets a person direct coding agents running on their computers. Human-facing identity, lifecycle reporting, proactive voice, and realtime conversation remain separate from internal routing and provider mechanics.

## Agents

**Agent**:
A coding-agent session muxr tracks. It is the person-shaped row in the herd, not a pane, process, or provider binary.
_Avoid_: pane, tab, process, session row

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
The stable internal route that identifies an Agent across pane moves. The only key used to prompt, watch, or focus.
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

## Control plane

**Envelope**:
The unit the relay routes: a cleartext routing header plus an opaque payload the relay must never parse.
_Avoid_: packet, wire message, frame (for this unit)

**Routing Channel**:
Which encrypted stream an Envelope belongs to. The same vocabulary binds relay routing and E2EE context.
_Avoid_: V2Channel, transport, socket kind

**Device Grant**:
A machine-signed, device-sealed credential that names the data and ingress roots a device may use.
_Avoid_: token, certificate, pairing ticket
