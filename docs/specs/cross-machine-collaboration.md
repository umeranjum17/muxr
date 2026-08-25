---
title: Cross-machine agent collaboration
slug: cross-machine-collaboration
status: in-progress
created: 2026-08-25
updated: 2026-08-25
owner: umer
links:
  - remote-relay-enrollment
  - native-voice-transport
  - ../ARCHITECTURE.md
  - ../VOICE-SETUP.md
---

# Cross-machine agent collaboration

## Context

muxr already lets a phone control one selected Herdr host through a machine-scoped, end-to-end encrypted connection. Each host owns its local panes, agents, worktrees, plugins, and provider credentials. The relay routes opaque envelopes and must remain unable to inspect agent traffic.

The missing capability is computer-to-computer collaboration. A Linux agent should be able to prompt and inspect an allowed Mac agent for Xcode work, and the Mac should be able to do the same in the other direction. The user must authorize this from mobile Settings by selecting paired computers. CLI commands may operate an established relationship but must never be required to connect machines.

Realtime voice remains the native streaming speech-to-speech path. One voice stream stays pinned to one host and session while constrained host-owned tools reach allowed peer machines. Audio is never fanned out or converted into an STT, LLM, and TTS pipeline.

## Product contract

- Settings exposes **Computer collaboration** separately from ordinary phone pairing.
- The user selects at least two paired computers and confirms that they may read agent output and send prompts to one another.
- muxr creates symmetric directed peer grants internally. The phone performs the authorization ceremony but is not required after setup.
- Established peers may list sessions, read panes, read status, register completion watches, and send prompts.
- Starting agents is a separate advanced capability. Arbitrary shell, raw Herdr CLI, destructive pane/workspace actions, terminal takeover, and arbitrary plugin calls are not part of the default peer grant.
- Disconnecting collaboration revokes peer credentials and connections. It is distinct from forgetting the phone's pairing with a computer.
- Machine, pane, session, device, and grant ids remain internal and are never displayed or spoken.

## Ownership and topology

Herdr remains local-only and owns PTYs, panes, agents, lifecycle, and scrollback. The muxr host adds a headless client role for explicitly authorized peers. The existing relay remains the outbound-only opaque router. No coordinator, mesh service, phone runtime proxy, mailbox, or cross-machine terminal federation is introduced.

A collaboration set is implemented as a small-N full mesh of directed grants. Each selected host generates a separate target-specific peer-client key. The phone forwards signed descriptors and opaque sealed grant bundles; peer private keys and usable remote credentials never reside on the phone.

The first version is intentionally capped to a small personal fleet. Partial convergence is expected when a selected computer is offline and must be shown honestly.

## Authorization ceremony

The shared contract adds four host-owned operations:

1. `peer.prepare` creates a target-specific peer key and machine-signed descriptor on the source host.
2. `peer.authorize` verifies the controlling phone and source descriptor on the target, records a `peer` device with explicit capabilities, and seals its credential and grant to the source peer key.
3. `peer.install` forwards the opaque bundle to the source, which verifies the target signature and stores it owner-only.
4. `peer.list` and `peer.revoke` expose converged status and security-first removal.

The phone may keep a non-authoritative pending plan so the screen can retry after an offline machine returns. Host records and target authority remain the truth.

Hosted and self-hosted authorities must implement equivalent peer issue, refresh, rotation, and revoke semantics. A peer is a distinct device kind, not a native phone disguised as `control`.

## Capability enforcement

Peer grants carry signed capabilities and the host dispatcher enforces them per authenticated peer device. The initial allowlist is:

- session and Herdr tree listing
- pane reads
- session status
- completion watch registration
- prompt delivery

Optional advanced permission:

- start an agent in an approved directory

Excluded from the initial peer surface:

- `machine.shell` and `session.shell`
- raw `herdr.cli`
- terminal control and takeover
- closing panes, tabs, or workspaces
- worktree landing
- arbitrary plugin calls or streams

A broad `control` boolean is insufficient because it is effectively remote code execution as the host user.

## Delivery, idempotency, and recovery

The relay currently buffers client-to-machine envelopes while a machine is offline. Peer mutations must therefore include encrypted `operationId` and `notValidAfter` metadata.

- The caller sends mutations only after an authenticated host frame proves the target is live.
- The target rejects expired mutations before dispatch.
- The target persists bounded operation receipts through their validity window.
- A retry reuses the same operation id and receives the first result rather than executing twice.
- The UI never says **Sent** until the target returns a receipt.
- Reads may retry normally.
- Reconnect always resnapshots `peer.list`, `herdr.tree`, and session state. Events are wake-ups, not canonical state.

Disconnect disables the source edge immediately, revokes the target peer device and credential, closes its sockets, and deletes the source bundle only after confirmation. Partial cleanup remains visible as **Disconnecting, waiting for computer**.

## Mobile Settings

The existing Machines section continues to own phone pairing, switching, and forgetting. A separate row opens the collaboration screen:

- **Computer collaboration** with summary `Off`, `3 computers`, or `Needs attention`
- paired computer list with name, platform, online status, and checkbox
- fixed recommended permission copy: `Read agent output and send prompts`
- optional advanced `Start agents` permission
- confirmation explaining that selected computers connect directly and the phone is not required afterward
- per-computer states: Connected, Setting up, Waiting for computer, Repair needed, Disconnecting
- machine detail copy such as `Collaborates with Mac and Linux`
- separate destructive `Disconnect collaboration` action

Forgetting a phone pairing warns when collaboration still exists. It never implies that peer credentials were revoked.

## Cross-machine agent operations

The host peer client exposes typed, capability-checked operations rather than arbitrary command execution:

- list machines and agent aliases
- list sessions on one allowed machine
- send a prompt to one agent
- read recent pane output
- read status and wait for completion
- optionally start an agent when the advanced capability is present

Stable muxr session identity remains the routing handle internally. User-facing commands and UI use human machine and agent aliases. Ambiguous aliases require clarification.

## Realtime voice

Voice state changes from a session-only target to `{ machineId, sessionId }`. Starting a call captures an immutable target machine, relay URL, grant, plugin snapshot, and provider. Reconnect uses that captured target even if global Settings changes.

- One microphone owner and one direct provider stream remain invariant.
- The call stays on the host/session where it started.
- Switching the app's active computer during a call requires **End voice and switch**.
- Cross-machine requests use a host-owned constrained peer broker with tools for listing machines and agents, prompting, reading output, and watching completion.
- Provider plugins receive neither peer credentials nor unrestricted remote CLI access.
- Peer pane output stays untrusted data and cannot authorize actions.
- Ambiguous spoken machine or agent names trigger a short clarification.
- The overlay may say `Voice on Linux · working with Mac / iOS builder`, never internal ids.
- Remote destructive voice actions remain out of scope.

Only the pinned voice host needs a configured provider. Other peers do not need voice credentials.

## Implementation phases inside one feature PR

1. Add peer contract types, signed capability claims, persistence, authorization ceremony, rotation, and revocation.
2. Add the host outbound peer client and safe read, prompt, status, watch, and optional start operations.
3. Add durable freshness and idempotency receipts for every peer mutation.
4. Add the Settings collaboration flow, convergence states, repair, and disconnect UX.
5. Make realtime targets machine-aware and pin reconnect state.
6. Add constrained peer tools to the voice host without exposing credentials to provider plugins.
7. Exercise hosted and self-hosted flows, then finish adversarial review and release evidence.

The work lands as one cohesive feature PR with reviewable internal commits.

## Primary files

- `packages/crypto/src/index.ts`
- `packages/contract/src/requests.ts`
- `packages/contract/src/wire.ts`
- `apps/relay/src/machineAuthority.ts`
- `apps/relay/src/selfhostPairing.ts`
- `apps/host/src/main.ts`
- `apps/host/src/host.ts`
- `apps/host/src/requests/createRequestDispatcher.ts`
- `apps/host/src/herdr/herdrSessionSource.ts`
- new host peer client, store, receipt, and broker modules under `apps/host/src/peer/`
- `apps/mobile/sources/components/SettingsView.tsx`
- machine detail and pairing routes under `apps/mobile/sources/app/(app)/`
- `apps/mobile/sources/state/hostedE2ee.ts`
- `apps/mobile/sources/plugins/openPluginStream.ts`
- `apps/mobile/sources/realtime/realtimeSessionState.ts`
- `apps/mobile/sources/voice/realtimeSession.ts`
- bundled voice provider stream adapters under `plugins/voice*/`

## Verification

- [ ] Two paired computers can be selected in Settings and converge to symmetric peer grants without CLI setup.
- [ ] The phone may go offline after setup while peers continue to connect directly.
- [ ] A peer can list agents, send one prompt, watch completion, and read recent pane output on the other computer.
- [ ] Observe-only and default peer capabilities reject shell, raw Herdr CLI, close, takeover, worktree landing, and undeclared plugin operations.
- [ ] A timed-out or offline-buffered prompt cannot execute after `notValidAfter` and a retried operation executes once.
- [ ] Revocation closes live peer sockets and blocks future tickets and mutations.
- [ ] Offline setup and disconnect show pending state and converge after the missing computer returns.
- [ ] Forgetting a phone pairing never claims peer collaboration was revoked.
- [ ] Voice stays one native realtime speech-to-speech stream pinned to its original machine/session across reconnects.
- [ ] Voice can unambiguously prompt, watch, and summarize an allowed remote agent without receiving peer credentials.
- [ ] Switching computers during voice requires explicit call termination.
- [ ] Internal ids, raw terminal output, credentials, and private paths are never displayed or spoken.
- [ ] Existing local Herdr, pairing, plugin, voice, Android, iOS, and relay isolation flows remain green.
