# 0001 — Keep a device paired until revocation

Tier: T3 (security, authority, data lifecycle)  
Status: accepted  
Date: 2026-08-12  
Decider: Umer

## Decision

A verified phone remains paired until explicitly revoked. muxr MUST NOT require calendar-based QR re-pairing. Pairing tickets remain short-lived and single-use. A device MUST re-pair only after revocation, device SecureStore/key loss, machine identity reset, or an unrecoverable key-version mismatch.

## Alternatives

- Re-pair every 30 days: rejected because expiry silently removes a valid ingress key without providing meaningful revocation or renewal.
- Automatic calendar renewal: rejected for now because durable device identity plus explicit revocation is simpler and works offline.

## Evidence and standards

The grant is bound to a device key; expiry is not revocation. The current 30-day cliff drops the mobile grant and host ingress key with no recovery path. Self-hosted machines may be offline from any control plane. Security comes from per-device credentials, immediate socket/credential revocation, and key rotation excluding the revoked device.

Claude: APPROVE — routine 30-day re-pairing is security-shaped friction.  
Codex: APPROVE WITH NOTE — self-host revocation must remove/rotate E2EE device keys, not only mark the relay credential revoked.  
Owner: accepted.

## Failure scenario

A paired phone reaches day 30 while its machine is healthy; both sides discard the valid grant and the user loses access without a security event or renewal path.

## Validation

Implemented and independently approved by Claude and Codex. `scripts/diagnostics/application/checkSelfhostRevocation.mjs` pairs two devices through the real relay, revokes one, proves its live socket, credential, pre-minted ticket, and grant fail, rotates the shared/per-device keys for the survivor, restarts the relay, and proves revocation persists while the survivor reconnects. The forced workspace/mobile typechecks, crypto self-check, and focused mobile terminal/sync flows pass.

## Rollback and reopen trigger

Reverting to bounded expiry requires a working background renewal path first. Reopen if revocation cannot reliably remove a lost device, or if platform key storage cannot preserve identity across normal upgrades.
