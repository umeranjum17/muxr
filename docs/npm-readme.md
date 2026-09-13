# muxr

**Every coding agent, in your browser and your pocket.** [Website](https://trymuxr.com) · [Demo](https://trymuxr.com/demo) · [GitHub](https://github.com/umeranjum17/muxr) · [Install guide](https://github.com/umeranjum17/muxr/blob/main/docs/user/install.md)

The `@trymuxr/cli` package is the complete self-hosted CLI, relay, host bridge, plugin runtime and browser app. It is what the Herdr plugin installs, and what you install yourself without Herdr.

## Install

In Herdr (recommended), on the computer that runs your agents:

<!-- herdr-commands:start -->
```text
herdr plugin install umeranjum17/muxr/plugins/control --ref v0.1.28
herdr plugin pane open --plugin muxr.control --entrypoint setup
```
<!-- herdr-commands:end -->

Without Herdr (Node 22+; setup installs Herdr for you):

<!-- npm-commands:start -->
```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```
<!-- npm-commands:end -->

`@latest` is the stable CLI and `@nightly` the newest build; both tags are the same CLI on your computer, so switching tags replaces the host you already run.

## First run

1. Setup checks the computer, recommends one browser-capable route (Tailscale Serve, cloudflared, or your own HTTPS origin) and names the prerequisite when it found only a native-only route.
2. Review shows the plan and the exact `~/.muxr/config.env` it writes. Nothing changes before **Apply setup**.
3. Open the printed pairing link in the browser you want to use; consent shows the computer, the role and the expiry. The native apps are optional and pair with `muxr pair --native`.

## Commands

```
muxr                           # interactive setup and maintenance menu
muxr config [--json|--schema]  # effective desired state and where each value came from
muxr setup --apply-config --dry-run --json   # plan; exit 2 when there are changes
muxr setup --apply-config --json             # apply and verify
muxr doctor [--json]           # health rows, exact runtime identity
muxr pair --browser            # Control browser (default); --browser-view, --browser-personal, --native
muxr devices list|revoke <n>
muxr voice status|select|key   # realtime voice provider, on this computer only
muxr update [--check|--yes] [--to <version> --allow-downgrade]
muxr uninstall --yes
muxr --skill                   # compact agent skill; muxr skill onboarding for the reference
```

muxr never installs skills or edits agent instruction files. State lives under `~/.muxr` unless `MUXR_HOME` is set; secrets never live in `config.env`.

## Build a plugin

Bundled and third-party plugins use the same public contract. The authoring guide ships in this package as `PLUGINS.md` (`muxr plugin docs` prints its path).

```
muxr plugin create <name>
muxr plugin check <path>
muxr plugin install <local-path|owner/repo[/subdir]@<sha>|npm:<name>@<version>>
```

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

Apache-2.0. Dependency notices and the resolved license inventory are included in `NOTICE`, `LICENSES/` and `THIRD_PARTY_LICENSES.json`.
