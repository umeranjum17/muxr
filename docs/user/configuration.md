# Configuration

The editable settings and their current limitations live in one
[configuration reference](../../skills/muxr/references/configuration.md).
`muxr config`, `muxr config --json` and `muxr config --schema` inspect the installed
contract. `muxr config export` exports stored desired values, not machine identity.

Version-2 `selfhost.json` has editable desired keys at the top level and generated
credentials/observations under `runtime`. The whole file stays private.
`config.env` is a legacy source; alongside version 2 it is a conflict.

**The storage format does not imply all commands shipped:** `config set` and
`config apply` still return “not in this build yet.” Use the reference's
[supported change paths](../../skills/muxr/references/configuration.md#what-a-change-can-do-now)
and distinguish a saved value from actual service health.

Before setting up a second instance or restarting one, check
[service ownership and socket paths](../../skills/muxr/references/configuration.md#service-ownership-and-a-second-instance).
`MUXR_HOME` alone does not isolate the registered service.

For a failure, start with [symptom → cause → command](../../skills/muxr/references/configuration.md#troubleshooting)
or [Troubleshooting](troubleshooting.md).

<!-- release-facts:start -->
| Fact | Value |
|---|---|
| Current release | `@trymuxr/cli@0.1.28` (tag `v0.1.28`) |
| Minimum Herdr | 0.8.0 |
| Minimum Node (npm path) | 22 |
| Default relay port | 8792 |
| Pairing link | one use, expires in 2 minutes |
| Browser access (Control or View-only) | 8 hours |
| Personal Control (installed browser you own) | 30 days |
| Machine enrollment (shared relay) | 5 minutes |
| Native apps | optional: [Android APK](https://trymuxr.com/downloads/stable/android) ([checksums](https://trymuxr.com/downloads/stable/checksums)), [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app), [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN) — availability depends on store review; [all channels](https://trymuxr.com/downloads) |
<!-- release-facts:end -->

Next: [Trust](trust.md).
