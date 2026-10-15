# 0006: Native SSH loopback transport

- Status: implemented
- Tier: T3
- Date: 2026-09-14

## Owner decision

Add a direct SSH choice for Android and iOS native builds alongside the
[self-host route picker](../SELF-HOSTING.md#reaching-the-relay-from-your-phone).
The phone opens a normal SSH client session to
`sshd` and forwards the muxr relay's host-loopback port to a device-local port.
The paired machine's byokit link traffic uses that local forward. The saved
grant retains its original relay address. See the [terminal transport](../ARCHITECTURE.md#what-the-relay-does).

Native apps may pair through the SSH forward itself; see [Direct SSH](../SELF-HOSTING.md#direct-ssh)
for the pairing flow. The route can also be configured after the phone has been paired.
PWA does not advertise SSH because browsers cannot open native SSH connections; they keep Tailscale and the existing
private-network, LAN, tunnel, and custom WSS choices.

## Invariants

- SSH chooses only the byte route. Pairing, stable machine keys, link grants,
  and revocation remain authoritative.
- The SSH destination is always the host's loopback relay (`127.0.0.1`), never a
  public edge or an operated backend.
- Passwords, private keys, and passphrases are stored only in the device secure
  store. They never enter connection settings, logs, diagnostics, or the repo.
- The SSH host key is confirmed as a `SHA256:` fingerprint before any login;
  a route with no confirmed pin is refused, a later mismatch fails closed, and
  both require deliberate reconfiguration.
- SSH is an explicit native override; the
  [route picker](../SELF-HOSTING.md#reaching-the-relay-from-your-phone) owns the
  self-host recommendation policy.

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
  login key's public half from **Settings → Connection & updates** (native,
  consent-gated; see SELF-HOSTING.md). Editing the SSH user's
  `~/.ssh/authorized_keys` by hand remains the fallback.
- Ed25519 host or login key on Android: accepted; see Algorithm scope below.
- Host key changed: stop and review the machine; muxr does not reconnect around
  the mismatch.
- Loopback relay unavailable: check that muxr is running and that the configured
  relay port matches the host's loopback listener.
- Unsupported build: use a native build with SSH support, or use
  Tailscale / another supported relay. Web does not show a dead SSH
  control.

## Rollback

In **Settings → Connection & updates**, choose **Use current relay route
instead**. muxr closes the SSH forward and resumes the paired relay URL without
changing pairing keys or workspace state. Removing the saved SSH credential is
separate and optional.

## Algorithm scope (amended 2026-10-14)

The native SSH client (SSHJ) takes one JCA provider name. Android's platform
"BC" provider lacks the X25519, EC, and Ed25519 operations SSHJ needs, and the
bundled Bouncy Castle jar loses the `BC` name to the platform copy. The
2026-09-15 qualification pointed SSHJ at Conscrypt and dropped Ed25519. The
client now registers a muxr-named provider holding a full Bouncy Castle copy
and uses it for all SSHJ crypto; Conscrypt is no longer used. Ed25519 login
keys need Bouncy Castle, so one provider serves every algorithm.

Key exchange is curve25519 and ECDH. Host-key and login-key algorithms are
RSA, ECDSA, and Ed25519, with the RSA/ECDSA preference order kept first so
saved RSA/ECDSA host-key pins keep verifying. Ed25519 host keys still go
through pinned verification. The Android behaviour is proven on device only
through the verify-pockit `ssh-login-keys` lab. iOS (libssh2/OpenSSL) is not
covered by this amendment.

## iOS counterpart

The local Expo module exposes the same `SshTunnel` interface on iOS. It builds
libssh2 from a pinned upstream revision with OpenSSL, instead of shipping an
older precompiled SSH client. The source pod declaration is owned by
`apps/mobile/modules/ssh-tunnel/ios/MuxrSSH2.podspec`; the Expo config plugin
keeps it in regenerated Podfiles. Android's SSHJ implementation is unchanged.

One serial queue owns each iOS SSH session, its loopback listeners, and its
channels. The shared JS path owns pairing, secure credentials, host-key pins,
and reconnects on both platforms. Closing the tunnel closes all extra forwards;
credential verification uses a separate connection and leaves a live route alone.

## Verification

- Android native build opens an SSH forward to the host loopback and reaches the
  existing relay's authenticated host frame through the ordinary mobile sync
  flow.
- The same candidate rejects a changed host key and displays an actionable
  failure without exposing credential material.
- Settings on PWA contain no SSH option; Tailscale and the other supported
  routes remain available.
- Existing Tailscale Serve diagnostics and self-host revocation checks continue
  to pass.
