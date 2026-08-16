# 0004: Tailscale ingress ownership

- Status: implemented
- Tier: T3
- Date: 2026-08-13

## Owner decision

In Tailscale mode muxr keeps its relay on loopback and publishes it through a muxr-owned Tailscale Serve mapping. muxr device grants and E2EE remain authoritative; Tailscale is transport only.

## Invariants

- Never use Funnel.
- Never overwrite or reset a Serve configuration muxr cannot prove it owns.
- Prefer `Self.DNSName` from `tailscale status --json`; direct tailnet IP is the explicit rollback.
- Pairing, tickets, revocation, and relay-side ciphertext behavior do not change.

## Failure cases

- Tailscale logged out or MagicDNS absent: fail with an actionable message; do not silently expose LAN.
- Root Serve handler occupied: refuse and ask the owner to choose a different path/port.
- Serve command unavailable or denied: preserve direct `ws://<tailnet-ip>:<port>` rollback via `--tailscale-direct`.
- Mapping changed after setup: muxr does not remove or replace it without matching its recorded fingerprint.

## Rollback

Run `muxr self-host --tailscale-direct` to use the previous direct-tailnet address and bind. No pairing keys or workspace state are migrated.

## Verification

```bash
node scripts/checkTailscaleIngress.mjs
node scripts/checkSelfhostRevocation.mjs
```

The first check uses a fake Tailscale CLI and verifies MagicDNS selection, loopback relay bind, Serve invocation, occupied-handler refusal, and direct fallback. The pairing check proves application-layer authority remains intact.
