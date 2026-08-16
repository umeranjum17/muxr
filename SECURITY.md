# Security

muxr is a remote control surface for the agents on your machine: it pairs devices, relays end-to-end encrypted terminal and session traffic, and runs host plugins. Treat anything that weakens those boundaries as a vulnerability.

## Supported versions

muxr is pre-1.0. Only the `main` branch of this repository receives security fixes. If you run a fork or an old checkout, you run it without security support.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue.

- Preferred: open a private security advisory on the GitHub repository (Security, then Advisories, then Report a vulnerability).
- Fallback: email umeranjum17@gmail.com.

Acknowledgement within 7 days. Include enough detail to reproduce the issue, which boundary it crosses, and what you expect the impact to be.

## Dependency policy

Release work updates every dependency with an available security fix and runs the full suite after lockfile changes. Expo's build-only Metro toolchain currently depends on `image-size@1.2.1`, for which GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr have no patched upstream release. `patch-package` applies `patches/image-size+1.2.1.patch`; the postinstall verifier runs a malformed-ICNS probe in a bounded child process so the zero-length loop guard cannot silently disappear. This build dependency is not shipped in the `@trymuxr/cli` artifact.

## What is not a vulnerability

muxr has a deliberate trust model. Read [docs/PLUGINS.md](docs/PLUGINS.md), section "Trust", before reporting.

- A paired phone or browser-with-shell-grants is equivalent to sitting at the host user's shell. `session.shell`, `machine.shell`, and `herdr.cli` are the product. "A paired device can run commands as me" is not a vulnerability.
- The bundled Runbook plugin is a remote shell for saved commands. Same trust model: installing and approving it is equivalent to trusting that code as the host user.
- Herdr backend plugins run unsandboxed as the host user by design. "A malicious plugin can run code on the host" is not a vulnerability; installing a plugin is equivalent to trusting local code.
- muxr's declarative UI limits what reaches the phone. It does not sandbox the backend, and it is not a defense against a plugin you chose to install and enable.
- The CLI management metadata (manifest hashes, provenance) is not a trust boundary against the same host user, who can modify it.

## What is in scope

- Pairing or approval bypass: a device gaining access without an explicit approval, or a contribution surviving an approval rotation.
- E2EE weaknesses: the relay, or anyone without the device key, reading terminal or session plaintext outside the explicit loopback development fixture.
- A plugin reaching authority it did not declare: a declarative contribution obtaining capabilities beyond the parsed manifest.
- Cross-device approval leakage: approval granted on one device being usable by another.
- The relay reading or altering ciphertext it routes.
