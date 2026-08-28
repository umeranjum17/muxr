---
title: Shared Remote Relay Enrollment
slug: remote-relay-enrollment
status: implemented
created: 2026-08-17
updated: 2026-08-20
owner: umer
links:
  - ../SELF-HOSTING.md
  - ../../scripts/setup/application/wizard.mjs
---

# Shared Remote Relay Enrollment

## Context

muxr already supports one self-hosted relay beside one agent host. A durable VPS relay should let several agent machines connect outbound to one always-on ciphertext router, while keeping Herdr and the agent host on each local machine. A relay URL alone is not authority. The current relay mint secret owns every machine, pairing session, device, grant, and revocation, so it must never leave the VPS.

The CLI must expose two clearly different choices:

1. **Host a shared relay on this server**: install a supervised relay-only service, configure HTTPS/WSS and optional read-only web hosting, then create short-lived machine enrollment links.
2. **Connect this agent machine to a shared relay**: generate machine keys locally, claim one enrollment, store only a machine-scoped credential, start the local Herdr host bridge, then pair a phone or browser.

## Authority model

- Relay owner authority stays on the VPS and is the only authority that creates enrollments, lists machines, or revokes machines.
- Enrollment claims are SHA-256 hashed at rest, expire after five minutes, are single-use, and are failure-rate-limited.
- The agent submits its Ed25519 signing public key and proves possession by signing a domain-separated enrollment challenge containing the enrollment id, relay URL, and public key.
- The relay derives the machine slug from the canonical signing public key. A client never chooses another machine's slug.
- The issued opaque machine credential is hashed at rest and bound to one slug, one credential id, expiry, and revocation state.
- Machine credentials mint machine tickets, open/poll pairing sessions, upload grants, list their devices, rotate their grants, and revoke their devices only for their bound slug.
- Device credentials remain client-only and machine-bound.
- Machine revocation invalidates unused tickets and immediately closes the machine and device peers for that slug.
- Native pairing displays one relay-qualified short string such as `wss://relay.example?pair=7KDM4-QXP7N`; QR encodes the same value.
- Pairing codes expire after two minutes. The relay stores only a code hash and code-encrypted payload, deletes both atomically on first resolution, and deletes the underlying handoff after grant retrieval.
- The existing E2EE grant and envelope crypto remains unchanged. The relay continues routing ciphertext only.

## CLI experience

### VPS

Interactive `muxr` offers **Host or manage a shared relay**.

The reviewed plan includes the bind port, public WSS URL, ingress provider, optional web URL, relay-only service registration, and owner state path. Apply defaults to Cancel. After health verification, the CLI reports:

- relay location: this server;
- relay and web URLs;
- relay service and ingress health;
- enrolled machine count;
- `~/.muxr` owner-state location;
- **Create machine enrollment** as the next action.

Creating an enrollment prints one pasteable `muxr://enroll?...` string and QR containing only relay endpoint, enrollment id, one-time claim, and public challenge data. It never contains the owner secret.

### Agent machine

Interactive `muxr` offers **Connect this machine to a shared relay**.

The user pastes the enrollment string. The CLI validates WSS, creates keys locally, signs the challenge, claims enrollment, verifies the server-derived slug, stores the scoped credential owner-only, registers the local host service, verifies the host reaches the relay, then offers phone/browser pairing.

The completion summary reports relay location, relay URL, local host and Herdr health, credential expiry, pairing outcome, integrations/plugins, and `~/.muxr`. Native pairing shows a short relay-qualified code string rather than its cryptographic payload. It never reports internal ids, credentials, or keys.

### Management

The VPS menu includes **Machines** with friendly names and list-number selection for revoke. The agent menu includes connection health and re-enrollment guidance. Expired enrollment links say so and direct the user back to **Create machine enrollment**.

## Implementation order

1. Split relay-owner state from machine state without changing current single-machine behavior.
2. Add the persisted machine authority and one-use enrollment store.
3. Add owner-only create/list/revoke routes and public proof-of-possession claim.
4. Accept machine credentials on ticket issuance and bind machine tickets to credential id/expiry.
5. Scope pair, poll, grant, device, rotation, and revoke operations to the authenticated slug.
6. Revalidate machine credential state when consuming tickets and close peers on machine revoke.
7. Parameterize CLI control requests for remote HTTPS instead of loopback-only endpoints.
8. Add relay-only and remote-host supervised service modes.
9. Add the two interactive workflows and safe completion summaries.
10. Replace native pairing payload display with an encrypted two-minute short-code lookup on the selected relay.
11. Update docs and package smoke.

## Files

- `apps/relay/src/machineAuthority.ts`: enrollment and machine credential persistence.
- `apps/relay/src/relay.ts`: owner, enrollment, machine-scoped administration, and peer revocation routes.
- `apps/relay/src/auth.ts`, `apps/relay/src/selfhostTickets.ts`: credential-bound tickets.
- `apps/relay/src/selfhostPairing.ts`: slug-scoped pair/device/grant operations and consumed short-code lookup.
- `packages/crypto/src/index.ts`: shared pairing-code payload encryption.
- `apps/host/src/main.ts`: accept machine-scoped self-host credentials and remote relay URLs.
- `scripts/setup/application/hosted.mjs`: split state, remote control base, enrollment claim, machine management, service modes.
- `scripts/setup/application/wizard.mjs`, `scripts/cli.mjs`: separate VPS-host and remote-connect journeys.
- `scripts/diagnostics/application/checkRemoteRelay.mjs`: one end-to-end multi-machine security flow.
- `docs/SELF-HOSTING.md`, `README.md`, `docs/npm-readme.md`: user paths and threat boundary.

## Verification

- [x] Owner creates a five-minute enrollment; only a hash is persisted.
- [x] Agent proves possession of its signing key; relay derives the slug and issues one scoped credential.
- [x] Enrollment replay, expiry, malformed key, bad signature, URL mismatch, and concurrent double-claim fail.
- [x] Machine A can mint only machine tickets for A and administer only A's pairing/devices/grants.
- [x] Machine A cannot list, rotate, or revoke machine B's devices.
- [x] Device credentials remain client-only and bound to their machine.
- [x] Revoking machine B invalidates B's unused tickets and drops B's live host/client peers without affecting A.
- [x] Relay-only unit generation, Linux linger, immediate-stop child cleanup, restart, update, and doctor profile pass package smoke.
- [x] Agent host uses only the remote WSS URL and machine credential, waits for authenticated presence, and resumes interrupted enrollment.
- [x] Native QR and manual entry use the same short relay-qualified pairing code.
- [x] Code lookup expires after two minutes, is deleted on first resolution, and does not expose the embedded pairing secret to the relay.
- [x] Clickable read-only browser pairing retains server-bound authority and secure-context checks.
- [x] Final summaries expose URLs and health, never ids, credentials, claims, or keys.
- [x] Existing local self-host flow, 30-gate suite, and package smoke are green.
- [x] The EAS Cloud Android 0.1.11 emulator build accepted a live Tailscale pairing string, completed the grant handoff, deleted relay lookup state, and reached the connected Herd screen.

## Revisions

- 2026-08-20: Keep QR scanning and manual entry as separate onboarding choices, remove the repeated QR action from the manual screen, and expose the paired relay, transport, and CLI version in machine details.
- 2026-08-20: Replace native long payload strings with short relay-qualified pairing codes while preserving broker-free custom relay discovery and relay-blind pairing secrets.
