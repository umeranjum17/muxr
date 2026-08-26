---
title: Cross-machine agent collaboration
slug: cross-machine-collaboration
status: in-progress
created: 2026-08-25
updated: 2026-08-26
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

Deferred advanced permission:

- start an agent in an approved directory, after Settings can choose target-owned directories without guessing from an inactive global machine catalog

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

- **Computer collaboration** with summary `Off`, `Setting up`, `Disconnecting`, a computer count, or `Needs attention` only when repair is actually required
- paired computer list with name, platform, online status, and checkbox
- an interactive **Agent collaboration** permission switch for the safe `Read agent output and send prompts` bundle
- turning the switch on confirms and authorizes the selected computers; turning it off confirms and revokes their peer access
- explicit per-machine causes: `Update muxr`, `Computer unavailable`, `Pair again`, `Repair needed`, or `Connected`, never a swallowed generic `Unknown`
- a clear success receipt only after every directed peer grant is active; pending setup or revocation exposes a contextual retry action
- starting agents is explicitly unavailable until exact target-directory approval exists; no fake or disabled permission control is rendered
- per-computer states: Connected, Setting up, Waiting for computer, Repair needed, Disconnecting
- machine detail copy such as `Collaborates with Mac and Linux`

Forgetting a phone pairing warns when collaboration still exists. It never implies that peer credentials were revoked.

## Cross-machine agent operations

The host peer client exposes typed, capability-checked operations rather than arbitrary command execution. The running host publishes an owner-only local broker capability so any local coding agent can use human-named CLI commands after reading `muxr --skill`:

- `muxr peers list`
- `muxr peers read --machine <name> [--agent <name>]`
- `muxr peers status --machine <name> [--agent <name>]`
- `muxr peers watch --machine <name> [--agent <name>]`
- `muxr peers prompt --machine <name> [--agent <name>] --text <prompt>`

The local broker inherits the existing peer grant allowlist and never exposes raw shell, terminal takeover, destructive operations, or undeclared plugin calls. Starting an agent remains unavailable until Settings can approve an exact target-reported directory.

Stable muxr session identity remains the routing handle internally. User-facing commands and UI use human machine and agent aliases. Ambiguous aliases require clarification.

## Host diagnostics

Every computer keeps a bounded, owner-only structured journal at `~/.muxr/host/diagnostics.json`. `muxr diagnostics` exposes it locally so an agent can inspect relay state, recently seen client kinds, peer relationship counts, collaboration requests, local broker operations, outcomes, and durations without scraping raw service logs.

The journal retains at most 512 allowlisted events for seven days and is capped at 256 KiB. It never records prompts, terminal or file content, paths, credentials, keys, or internal machine, device, relationship, session, pane, tab, workspace, request, or operation ids. There are no background uploads or daily dumps. Client presence is labelled as recently seen because the relay does not provide an exact client disconnect signal.

## Realtime voice

Voice state changes from a session-only target to `{ machineId, sessionId }`. Starting a call captures an immutable target machine, relay URL, grant, plugin snapshot, and provider. Reconnect uses that captured target even if global Settings changes.

- One microphone owner and one direct provider stream remain invariant.
- The call stays on the host/session where it started.
- Switching the app's active computer during a call requires **End voice and switch**.
- Cross-machine requests use a host-owned constrained peer broker with tools for listing machines and agents, prompting, reading output, and watching completion.
- Provider plugins receive neither peer credentials nor unrestricted remote CLI access. An approved `voice.session` child receives one revocable per-stream broker token as least-ambient routing; enabled backends remain trusted unsandboxed local code, so this token is not a hostile same-user isolation boundary.
- Peer pane output stays untrusted data and cannot authorize actions.
- Ambiguous spoken machine or agent names trigger a short clarification.
- The overlay may say `Voice on Linux · working with Mac / iOS builder`, never internal ids.
- Remote destructive voice actions remain out of scope.

Only the pinned voice host needs a configured provider. Other peers do not need voice credentials.

## Adversarial release hardening

The release implementation adds the following security and recovery invariants:

- peer mutations expire after five minutes and each device has a strict 64-receipt admission cap; authenticated revocation is idempotent and bypasses attacker-controlled receipts
- `peer.authorize` journals before authority issuance, checkpoints hosted pair-session recovery, uploads the grant before local crypto activation, persists a repair-visible relationship, and resumes every phase after restart
- legacy peer crypto devices without a relationship are discovered and revoked through key rotation instead of consuming fleet slots forever
- hosted issuance uses the deployed generic pair-session claim and grant flow, device revoke, and machine key rotation APIs; self-host keeps its dedicated peer routes
- a peer client sends mutations only after a fresh random liveness request receives its correlated encrypted result
- decrypted client frames are validated before host access and malformed-frame errors are null-safe
- voice adapters expose no raw Herdr CLI or close tool; remote output is bounded and redacts credentials, internal ids, and private paths before provider access
- voice reconnect refreshes only the pinned machine's grant generation, and every pairing entry point requires **End voice and switch** before changing the active machine

The optional **Start agents** permission remains deferred. It returns only when Settings can present target-reported directories and the user can approve an exact directory per machine.

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
- `apps/host/src/diagnostics/journal.ts`
- `scripts/diagnostics.mjs`
- `apps/mobile/sources/components/SettingsView.tsx`
- machine detail and pairing routes under `apps/mobile/sources/app/(app)/`
- `apps/mobile/sources/state/hostedE2ee.ts`
- `apps/mobile/sources/plugins/openPluginStream.ts`
- `apps/mobile/sources/realtime/realtimeSessionState.ts`
- `apps/mobile/sources/voice/realtimeSession.ts`
- bundled voice provider stream adapters under `plugins/voice*/`

## Revisions

- 2026-08-25: hardened the release after hostile review: receipt admission and security-first revoke, crash-recoverable authorization, correlated liveness, strict frame validation, deployed hosted generic pairing APIs, immutable voice grant refresh, pairing guards, destructive voice-tool removal, and remote-output redaction.
- 2026-08-25: reopened after owner review to add directed watch settlement, per-stream voice broker capabilities and strict parsing, retryable recovery fencing, canonical mobile authority reconciliation, stable human aliases, and focused PeerRuntime responsibility extraction.
- 2026-08-25: reopened after independent Sol review for active capability abort, exact private watch settlement, reconnect-safe semantic mutations, security-first local revocation, alias churn, deep mobile intent normalization, and precise trusted-local-plugin documentation.
- 2026-08-26: reopened after live owner testing because machine checkmarks looked persisted before confirmation, the permission card was not interactive, and ordinary offline setup was mislabeled `Needs attention`; replace the fixed card with a real revoking switch, reserve the warning for repair, and keep interrupted authorization and pending disconnect retries convergent.
- 2026-08-26: reopened after the third owner iteration and a Fable HOLD: add an ordinary-agent peer CLI, preserve outdated/offline/authorization causes through Settings with an explicit Connected receipt, and make CLI skill loading progressive instead of dumping every reference.
- 2026-08-26: reopened after live owner evidence showed the collaboration screen falsely rendered an empty pairing state while remote checks were pending; render saved grants immediately and add a bounded host diagnostic journal plus `muxr diagnostics` so local agents can inspect client, relay, peer, and broker history without raw log dumps.
- 2026-08-26: the real Android, Linux, and Hetzner journey exposed active-socket contention, owner-authority gaps, stale remote credentials, loopback peer bundles, incomplete peer-state validation, and revoked alias churn; v0.1.20 fixes each root cause and is implemented pending the remaining macOS and live voice acceptance.
- 2026-08-26: reopened after the first real Linux and macOS ceremony produced an asymmetric relationship: Linux installed outbound Mac access, but Mac rejected its reciprocal preparation step. Preserve the safe one-way edge, expose the failing machine and phase accurately, and make repair converge without weakening peer authority.
- 2026-08-26: instrumented Linux-to-Mac transport proved grant refresh, ticket issue, and socket open succeed before liveness times out. Upgraded local self-host state can retain a legacy machine credential that puts the host and peer sockets in different relay tenants; prefer local owner authority automatically, reject target/grant machine mismatches, preserve bounded phase diagnostics, attribute mobile failures only to the computer handling the failed phase, and prefix delivered prompts with the sanitized source-computer name so receiving agents know which peer spoke.
- 2026-08-26: both current runtimes proved a pre-migration relationship can remain canonically connected while liveness fails. Settings now probes each fully connected directed edge, marks only the broken direction for repair, and Retry revokes and recreates that peer device and relationship without deleting files or disturbing the healthy reverse direction.
- 2026-08-26: fresh reciprocal relationships still left Linux-to-Mac liveness blocked after successful grant refresh, ticket issue, and socket open while Mac-to-Linux passed. Target hosts now retain redacted `peer.ingress` received, decrypt-rejected, and decoded boundaries so one correlated attempt distinguishes relay delivery from ingress decryption without recording sender ids, keys, envelopes, or payloads.
- 2026-08-26: the correlated target window contained no peer ingress event, ruling out target-host decryption. The relay now retains 15 minutes / 64 owner-only redacted peer route outcomes (`delivered`, `tenant-mismatch`, or `target-unavailable`) and regression coverage reproduces a Linux peer ticket in the wrong self-host tenant while the Mac target socket is online.
- 2026-08-26: cross-relay evidence proved the Linux outbound peer opened against the wrong relay: the source relay delivered locally while the target Mac relay and host saw nothing. The target host now canonically signs only its own relay endpoint into the install bundle; an optional caller endpoint is an equality assertion that fails closed and can never select routing. The source persists that signed endpoint and uses it for grant refresh, ticket issue, and WebSocket creation. Local Tailscale hosts derive their owned public relay endpoint from current ingress instead of stale copied relay state. Distinct target/source/stale-relay coverage proves stale caller state is rejected, source and stale relays receive zero sockets, and the target receives and completes liveness.
- 2026-08-26: a failed authorization followed by matching revocation could clear the durable recovery journal but leave the runtime's cached recovery fence set, causing an immediate retry to fail in 1 ms. Successful cancellation now recomputes and clears the cache/timer when no work remains; `peer-recovery-pending` is allowlisted and rendered as a bounded retry message. Regression proves revoke followed immediately by prepare succeeds.
- 2026-08-26: real Linux-to-Mac and Mac-to-Linux list, status, bounded read, prompt, and completed watch all pass on identical packaged runtimes. A gated-auth experiment proved the target relay could drop immediate liveness frames before its asynchronous ticket check installed the message handler; relay sockets now pause before authentication and resume only after authorization, routing, and detach handlers are installed.
- 2026-08-26: thermonuclear restart and revocation review fenced disposed peer clients and relationships before durable cleanup, prevented stale socket callbacks and shutdown retries from recreating access, made daemon start/restart wait for the peer broker, retried transient launchd bootstrap error 5, and raised Linux's bounded service start burst to 20 per minute. Ten cold restart-to-first-list cycles pass in each direction.

## Verification

- [x] Two paired computers can be selected in Settings and converge to symmetric peer grants without CLI setup.
- [x] The phone may go offline after setup while peers continue to connect directly.
- [x] A peer can list agents, send one prompt, watch completion, and read recent pane output on the other computer.
- [x] Observe-only and default peer capabilities reject shell, raw Herdr CLI, close, takeover, worktree landing, and undeclared plugin operations.
- [x] A timed-out or offline-buffered prompt cannot execute after `notValidAfter` and a retried operation executes once.
- [x] Revocation closes live peer sockets and blocks future tickets and mutations.
- [x] Offline setup and disconnect show pending state and converge after the missing computer returns.
- [x] Forgetting a phone pairing never claims peer collaboration was revoked.
- [x] Voice stays one native realtime speech-to-speech stream pinned to its original machine/session across reconnects.
- [ ] Voice can unambiguously prompt, watch, and summarize an allowed remote agent without receiving peer credentials.
- [x] Switching computers during voice requires explicit call termination.
- [x] Internal ids, raw terminal output, credentials, and private paths are never displayed, spoken, or exported through diagnostics.
- [x] `muxr diagnostics` shows bounded relay, recently-seen client, peer relationship, collaboration request, and broker history after restart without prompts, paths, secrets, or raw/internal ids.
- [x] Existing local Herdr, pairing, plugin, voice, Android, iOS, and relay isolation flows remain green.

## Review evidence

- 2026-08-25: directed peer watch, broker capability/closed-union rejection, recovery retry/fencing, stable aliases, and canonical mobile reconciliation passed in the two existing flow suites (5 flow tests across 2 files).
- 2026-08-25: voice/provider checks passed (29 assertions across realtime session, provider refusal, and plugin catalog flows; bundled plugin policy and voice RPC lifecycle also passed).
- 2026-08-25: strict workspace typecheck passed. `scripts/runSuite.mjs` passed 30/30 once; a final rerun passed 29/30 with only the live Herdr check timing out while scanning 95 sessions, and that exact check passed immediately when rerun alone.
- 2026-08-25: independent-review repairs passed the existing peer/mobile flow suites (5 flow tests): concurrent private watch correlation, watch and prompt reconnect with the same operation id, active broker-call revocation, local-first revocation recovery, alias churn, and malformed/duplicate intent normalization.
- 2026-08-25: the latest strict typecheck, voice/provider checks, bundled-plugin policy, voice RPC lifecycle, and `scripts/runSuite.mjs` all passed; the full suite finished 30/30 including live Herdr and package smoke checks.
- 2026-08-25: `git diff --check` passed.
- 2026-08-26: Fable first returned HOLD because terminal agents had no peer CLI and Settings swallowed compatibility errors. After the owner-only `muxr peers` path, actionable state model, progressive skill loading, real CLI flow assertions, package smoke, and 30/30 suite landed, Fable returned RELEASE conditional only on preserving the prior deterministic wait fix and tracking `scripts/peers.mjs`; both conditions are satisfied after rebase.
- 2026-08-26: a standalone Android build paired this Linux host and a fresh Hetzner self-host relay, rendered both saved computers immediately, reached the explicit **Computers connected** receipt, and left symmetric connected host relationships.
- 2026-08-26: with the phone force-stopped, the ordinary local CLI listed the VPS and exercised status, read, prompt, and watch; `muxr diagnostics` recorded bounded successful broker operations. Host restart preserved the relationship.
- 2026-08-26: mobile revocation made the CLI unavailable immediately, converged to an empty peer list, and a new authorization succeeded afterward. Final Fable review returned **SHIP**, the full suite passed 30/30, and npm v0.1.20 was published.
- 2026-08-26: PR #138 phase instrumentation isolated Linux-to-Mac failure to encrypted liveness after successful grant refresh, ticket issue, and WebSocket open. The target/grant machine invariant, liveness-timeout category, native polling suppression, one-machine error attribution, stale local machine-credential upgrade path, source-computer prompt provenance, and automatic one-direction relationship repair pass focused flows, strict typecheck, package smoke, and the full 30/30 suite.
- 2026-08-26: identical packaged Mac and Linux runtimes passed both reciprocal 5/5 matrices, including completed idle watches and readable output. Linux and macOS each passed 10/10 daemon restart → immediate first peer-list cycles; the full 30/30 suite, package smoke, strict typecheck, hosted authority rotation flow, revocation, relay isolation, voice lifecycle, and secret scan pass.
- Remaining live acceptance: cross-machine native voice with a real provider. Its pinned-stream, explicit-switch guard, per-stream broker capability, remote prompt/read/watch, output redaction, and capability revocation paths pass deterministic flows, but the spec remains `in-progress` until that real-provider ceremony runs.
