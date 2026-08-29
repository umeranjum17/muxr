# 0003 — Browser access is a short-lived paired device

Tier: T3 (credential storage and command authority)
Status: implemented
Date: 2026-08-13
Decider: Umer

## Decision

A muxr browser is a distinct, short-lived device. It does not reuse a phone credential, persist a native device grant in `localStorage`, or terminate end-to-end encryption at the relay.

The browser generates its own device key. Pairing requires confirmation from the machine or an already-paired phone, and the machine seals the grant to that browser key. Browser grants expire after eight hours and are read-only observation grants. Terminal mutation remains native-only until a separately reviewed short-lived escalation is implemented. Closing or idling the browser drops unwrapped key material; revocation closes its sockets and rotates the machine data key.

The web client is served from a dedicated origin with an explicit origin allowlist, strict CSP, no analytics or third-party scripts, and no account/device secrets embedded in static assets. The same web client and pairing protocol are available to every self-hoster.

## Required key handling

A non-extractable AES-GCM WebCrypto key stored in IndexedDB wraps the browser device secret, credentials, and grants. No secret material is written to localStorage or sessionStorage. This is not represented as equivalent to native SecureStore: live XSS can still ride an unlocked session.

## Failure cases

- Shared browser retains access after the user leaves: bounded by short expiry, idle lock, and explicit browser-device revocation.
- Agent output triggers XSS: bounded by strict CSP, removal or sandboxing of HTML/SVG sinks, short-lived keys, and read-only default.
- Pairing claim is stolen: claims remain one-use and the verification code must match on an already trusted surface before the machine issues a grant.
- Origin config drifts: requests fail closed with a useful diagnostic; wildcard CORS is forbidden.
- A web device is revoked while connected: every socket closes, stale tickets fail, and machine key rotation fences cached traffic.

## Rejected

- Storing credentials, private keys, data keys, or ingress keys in `localStorage` or `sessionStorage`.
- Treating browser-wrapped IndexedDB storage as equivalent to native SecureStore.
- Baking `EXPO_PUBLIC_MUXR_TOKEN` into an Expo export.
- Relay-side decryption for browsers.
- Durable browser grants matching native phone lifetime.

## Rollback

A server capability flag disables web pairing and returns 404 without a client release. Rollback revokes all browser devices, closes their sockets, rotates machine keys, and serves an unregistering service worker if one was deployed.

## Executable verification

One end-to-end flow must prove: browser key generation → machine-confirmed claim → machine-sealed grant → encrypted observe attach → mutation rejection → expiry/revocation → socket close and reconnect rejection. Static-export scanning must prove no configured credential or E2EE key appears in emitted assets. Browser QA must prove CSP/CORS/origin enforcement and that agent-controlled Mermaid/SVG content cannot execute script.

## Evidence and standards

The existing Expo web target stored credentials in `localStorage` and bypassed native guards. This record rejects that path and requires a distinct short-lived browser device, machine-issued grants, a dedicated origin, strict CSP, a read-only default, explicit authority escalation, and self-host parity.

## Reopen trigger

Reopen if browser platform support cannot provide the required wrapping primitive, if real users need durable offline browser grants, if a CSP-compatible terminal/markdown implementation cannot be achieved, or if browser takeover evidence changes the one-controller authority model in decision 0002.
