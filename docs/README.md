# muxr docs

## Use muxr

Six pages, in reading order. Two pages before your first real action.

1. [Introduction](user/introduction.md) — what muxr does and does not do; computer, host, relay, browser app, native app.
2. [Install](user/install.md) — requirements, Herdr-first install, npm fallback, setup, pairing, first action, verify.
3. [Daily use](user/daily-use.md) — Herd, attention, terminal, files and changes, preview and takeover, voice and dictation, notifications, recovery, native-only differences.
4. [Configuration](user/configuration.md) — `~/.muxr/config.env`, plan/apply/verify, advanced networking, shared relay, plugins, voice provider, update/rollback/uninstall.
5. [Trust](user/trust.md) — encryption, what the relay sees, browser roles and lifetimes, shell authority, preview isolation, revocation, provider data, a compromised device.
6. [Troubleshooting](user/troubleshooting.md) — symptom → safe check → expected → next action.

## Develop

- [Build a muxr plugin](PLUGINS.md) — the extension-authoring contract (also `muxr plugin docs`)
- [Bundled plugins](../plugins/README.md)
- [Contributing](../CONTRIBUTING.md)

## Maintainers

- [Architecture](ARCHITECTURE.md) · [ADRs](decisions/README.md) · [Spec board](specs/index.html) ([source](specs/))
- [Host/client contract gate](HOST-CONTRACT-COMPATIBILITY.md)
- [Release automation](RELEASING.md) — tag gate, npm trusted publishing, provenance
- [Native builds](NATIVE-BUILD.md) — local EAS APK; Expo Go will not work
- [Clean-room new-user smoke](NEW-USER-SMOKE.md)
- [npm package readme](npm-readme.md) — copied into the package; derived from the same commands and release facts as the pages above
- [License inventory](license-inventory.md)
