# 0006: Android SSH loopback transport

- Status: implemented
- Tier: T3
- Date: 2026-09-14

## Owner decision

Keep Tailscale Serve as the recommended self-host route and add a direct SSH
choice for Android native builds. The phone opens a normal SSH client session to
`sshd` and forwards the muxr relay's host-loopback port to a device-local port.
The existing relay ticket, device grant, and E2EE WebSocket then run unchanged
through that local forward.

The route is configured after the phone has been paired through an existing
route. PWA and iPhone builds do not advertise SSH because this native SSH
implementation is not available there; they keep Tailscale and the existing
private-network, LAN, tunnel, and custom WSS choices.

## Invariants

- SSH chooses only the byte route. Pairing, stable machine keys, device grants,
  revocation, relay tickets, and `DeviceV2Crypto` remain authoritative.
- The SSH destination is always the host's loopback relay (`127.0.0.1`), never a
  public edge or an operated backend.
- Passwords, private keys, and passphrases are stored only in the device secure
  store. They never enter connection settings, logs, diagnostics, or the repo.
- The first SSH host key is pinned as a `SHA256:` fingerprint; a later mismatch
  fails closed and requires deliberate reconfiguration.
- Tailscale Serve remains the default. SSH is an explicit Android-only override.

## User-facing evidence

The route and consent sequencing follows the real Moshi captures documented in
`data/pock-competitive-deep-luna2/report.md`: `moshi-19-add-menu.png` and
`moshi-20-manual-ssh-form.png` show the separate manual SSH route and explicit
host/user/auth fields; `moshi-04-easy-pair-linux-whathappens.png`,
`moshi-05-pair-confirm.png`, and `moshi-24-generate-key.png` show the required
actor/order, consent, and key-trust explanation. muxr keeps its own grant and
E2EE authority rather than copying Moshi's host-key pairing semantics. Collie's
host-side evidence (`collie-host-01`) reinforces the same narrow trust boundary:
setup should state what runs on the user's machine, avoid a managed service or
silent outbound dependency, and leave the remaining connection steps explicit.

## Failure cases

- SSH host unreachable or `sshd` unavailable: retry and check the configured
  host, port, network, and that the machine is awake.
- Credentials rejected: check the SSH username and password/key, or install the
  public key in the SSH user's `~/.ssh/authorized_keys`.
- Ed25519 host or login key: this build negotiates RSA/ECDSA only (see
  Algorithm scope below) and says so instead of failing as unreachable.
- Host key changed: stop and review the machine; muxr does not reconnect around
  the mismatch.
- Loopback relay unavailable: check that muxr is running and that the configured
  relay port matches the host's loopback listener.
- Unsupported build: use an Android native build with SSH support, or use
  Tailscale / another supported relay. Web and iPhone do not show a dead SSH
  control.

## Rollback

In **Settings → Connection & updates**, choose **Use current relay route
instead**. muxr closes the SSH forward and resumes the paired relay URL without
changing pairing keys or workspace state. Removing the saved SSH credential is
separate and optional.

## Algorithm scope (2026-09-15 qualification finding)

The native SSH client (SSHJ) resolves its algorithms through Android's
Conscrypt provider: Android's built-in "BC" provider cannot do X25519, EC, or
Ed25519 key agreement and signatures, and the bundled Bouncy Castle jar loses
the `BC` name to the platform copy, so the SSHJ defaults fail on every device
even though negotiation succeeds. The client therefore offers curve25519 and
ECDH key exchange with RSA/ECDSA host and login keys only. Servers fall back
to the RSA/ECDSA host keys OpenSSH generates by default; an Ed25519-only
server or an Ed25519 login key fails with an explicit unsupported-key message
rather than a generic unreachable error. Full Ed25519 support is future work,
not a correction to this decision.

## Verification

- Android native build opens an SSH forward to the host loopback and reaches the
  existing relay's authenticated host frame through the ordinary mobile sync
  flow.
- The same candidate rejects a changed host key and displays an actionable
  failure without exposing credential material.
- Settings on PWA/iPhone contain no SSH option; Tailscale and the other supported
  routes remain available.
- Existing Tailscale Serve diagnostics and self-host revocation checks continue
  to pass.
