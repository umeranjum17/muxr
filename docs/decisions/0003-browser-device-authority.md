# 0003 — Browser access is a short-lived paired device

Tier: T3 (credential storage and command authority)
Status: implemented
Date: 2026-08-13
Decider: Umer

## Decision

A muxr browser is a distinct, short-lived device. It does not reuse a phone credential, persist a native device grant in `localStorage`, or terminate end-to-end encryption at the relay.

The browser generates its own device key. Pairing requires matching confirmation words and approval on the computer, which admits a grant for that browser key. Shared browser grants expire after eight hours; a separate personal grant expires after 30 days. Browser pairing explicitly chooses control or view-only authority. Revocation closes its link; there is no shared machine data key to rotate. See [browser pairing](../SELF-HOSTING.md#quick-start).

The web client is served from the relay origin with an explicit origin allowlist, strict CSP, no analytics or third-party scripts, and no account/device secrets embedded in static assets. The same web client and pairing protocol are available to every self-hoster.

## Required key handling

A non-extractable AES-GCM WebCrypto key stored in IndexedDB wraps the browser device secret, credentials, and grants. No secret material is written to localStorage or sessionStorage. This is not represented as equivalent to native SecureStore: live XSS can still ride an unlocked session.

## Failure cases

- Shared browser retains access after the user leaves: bounded by short expiry, idle lock, and explicit browser-device revocation.
- Agent output triggers XSS: bounded by strict CSP, removal or sandboxing of HTML/SVG sinks, grant expiry, and explicit authority selection.
- Pairing offer is stolen: approval requires matching confirmation words on the computer before the grant is usable.
- Origin config drifts: requests fail closed with a useful diagnostic; wildcard CORS is forbidden.
- A web device is revoked while connected: its link closes and later requests are rejected.

## Rejected

- Storing credentials, private keys, data keys, or ingress keys in `localStorage` or `sessionStorage`.
- Treating browser-wrapped IndexedDB storage as equivalent to native SecureStore.
- Baking `EXPO_PUBLIC_MUXR_TOKEN` into an Expo export.
- Relay-side decryption for browsers.
- Durable browser grants matching native phone lifetime.

## Rollback

Rollback requires revoking browser grants and closing their links; the pre-cutover socket transport cannot be restored as a fallback.

## Executable verification

One end-to-end flow must prove: browser key generation → matching confirmation words and approval → link grant → encrypted attach with selected authority → expiry/revocation → link close and reconnect rejection. Static-export scanning must prove no configured credential or E2EE key appears in emitted assets. Browser QA must prove CSP/CORS/origin enforcement and that agent-controlled Mermaid/SVG content cannot execute script.

## Evidence and standards

The existing Expo web target stored credentials in `localStorage` and bypassed native guards. This record rejects that path and requires a distinct short-lived browser device, machine-issued grants, a relay origin with strict CSP, explicit authority selection and self-host parity.

## Reopen trigger

Reopen if browser platform support cannot provide the required wrapping primitive, if real users need durable offline browser grants, if a CSP-compatible terminal/markdown implementation cannot be achieved, or if terminal control evidence changes the one-controller authority model in decision 0002.
