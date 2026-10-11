# Support

muxr is free, open-source software (Apache-2.0) and self-hosted. You run the host and relay; the phone connects over an end-to-end encrypted connection. There is no muxr-operated account, email login, relay, or cloud service, no paid tier, and no support contract. Help happens in public, against the public repository.

## Get help

- [Troubleshooting](/docs/troubleshooting) — pairing, connectivity, key rotation, and redacted diagnostics.
- [Documentation](/docs) — quickstart, setup walkthrough, Herdr plugins, voice, and the trust model.
- [GitHub issues](https://github.com/umeranjum17/muxr/issues) — the support channel for the app, the CLI, and this website. Search first, then open an issue.

If pairing stopped working after this update, update both the computer CLI and phone app and pair once again. For a bug report, run `muxr doctor` and attach its redacted output. Never attach QR payloads, device or machine credentials, SecureStore data, provider keys, or raw muxr state files.

## Security and privacy

Report sensitive security or privacy issues through a [private GitHub security advisory](https://github.com/umeranjum17/muxr/security/advisories/new), not a public issue. The data-flow details live in the [privacy policy](/privacy).

## Scope

Because your own computer and your own relay hold the data, most recovery is in your hands: revoke devices from a paired machine, rotate keys by reconnecting the host, and remove local state to reset. The maintainers cannot recover pairing credentials, read your E2EE traffic, or reset your installation.
