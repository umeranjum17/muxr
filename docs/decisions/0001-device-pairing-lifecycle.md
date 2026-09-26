# 0001 — Keep a device paired until revocation

Tier: T3 (security, authority, data lifecycle)  
Status: accepted  
Date: 2026-08-12  
Decider: Umer

## Decision

A verified phone remains paired until explicitly revoked. muxr MUST NOT require calendar-based QR re-pairing. Pairing offers remain short-lived. A device must re-pair after revocation, device SecureStore/key loss, machine identity reset, an unrecoverable key-version mismatch, or the one-shot byokit wire cutover; see [the cutover contract](../specs/byokit-cutover.md).

## Alternatives

- Re-pair every 30 days: rejected because expiry silently removes a valid ingress key without providing meaningful revocation or renewal.
- Automatic calendar renewal: rejected for now because durable device identity plus explicit revocation is simpler and works offline.

## Evidence and standards

The grant is bound to a device key; expiry is not revocation. The current 30-day cliff drops the mobile grant and host ingress key with no recovery path. Self-hosted machines may be offline. Security comes from per-device link grants and immediate link revocation. The old shared-data-key rotation requirement was superseded by per-device Noise sessions; see [the transport architecture](../ARCHITECTURE.md#what-the-relay-does).

## Failure scenario

A paired phone reaches day 30 while its machine is healthy; both sides discard the valid grant and the user loses access without a security event or renewal path.

## Validation

The current link pairing and revocation flows are exercised in `scripts/diagnostics/application/linkPairing.integration.test.ts` and `pairedDevices.integration.test.ts`.

## Rollback and reopen trigger

Reverting to bounded expiry requires a working background renewal path first. Reopen if revocation cannot reliably remove a lost device, or if platform key storage cannot preserve identity across normal upgrades.
