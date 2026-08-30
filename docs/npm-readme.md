# muxr

**Every coding agent, on your phone.** [Website](https://trymuxr.com) · [GitHub](https://github.com/umeranjum17/muxr) · [Quickstart](https://trymuxr.com/docs/quickstart) · [Android APK](https://github.com/umeranjum17/muxr/releases/latest/download/muxr-android.apk) · [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN)

The `@trymuxr/cli` package installs the complete self-hosted CLI, relay, host bridge, plugin runtime, and web client.

## Quickstart

Requires Node 22+. If [Herdr](https://herdr.dev) is missing, setup installs and verifies it automatically.

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

The convenience installer at `https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh` performs that same npm install without `sudo`; it requires Node 22+ and does not install Node itself.

First run:

1. Install muxr on Android from Google Play testing or the [signed APK](https://github.com/umeranjum17/muxr/releases/latest/download/muxr-android.apk), verified by [SHA256SUMS](https://github.com/umeranjum17/muxr/releases/latest/download/SHA256SUMS). On iOS, open the [public TestFlight link](https://testflight.apple.com/join/aJSbs8pN); Apple is not accepting new testers right now.
2. Run `muxr`. It checks the computer, installs Herdr if needed, and asks how the phone should connect. Start with LAN when both devices use the same wifi.
3. Review the short plan, choose **Apply setup**, then scan the one-use QR from the phone app.

Nothing changes before **Apply setup**. Setup then verifies the connection and managed services without printing credentials. Run `muxr pair` anytime for a fresh QR.

Run `muxr` with no arguments for the interactive setup and maintenance menu. The same menu can host a supervised shared relay on a VPS, create one-use machine enrollments, or connect a local Herdr host using only a machine-scoped credential.

The bundled Usage item sheet runs the exact pinned [ccusage](https://github.com/ccusage/ccusage) backend offline against local coding-agent logs and shows today's allowlisted per-agent token totals without costs, prompts, models, or session details. It also lists every known installed CLI and distinguishes no activity reported today from agents ccusage does not support. npm installs one platform-specific ccusage binary (about 4 MB) for Linux or macOS. Current Codex percentages come from its local app-server; other coding CLIs are PATH-detected but never invoked.

```bash
muxr update                    # check, confirm, update, and restart
muxr update --check            # check without changing anything
muxr --skill                   # print the compact agent skill
muxr skill collaboration       # load one focused reference on demand
muxr doctor                    # current setup health
muxr diagnostics               # bounded redacted host/client history for agents
muxr pair                      # pair another phone
muxr pair --browser            # pair an 8-hour control browser
muxr pair --browser-view       # pair an 8-hour view-only browser
muxr devices list
muxr devices revoke <number>
```

muxr never installs skills or edits agent instruction files. Run `muxr --skill`
for the compact canonical workflow, then `muxr skill <topic>` only when the
current task needs that reference.

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set. Use `muxr setup --dry-run` to preview managed-file changes. `muxr uninstall` removes every muxr-owned operational component—including machine identity, pairings, grants, provider keys, runtime state, services, ingress, and managed integrations—then optionally removes the global CLI. It keeps Herdr, Herdr sessions, repositories, worktrees, received attachments, exports, signing keys, and unrecognized files. The narrower `muxr daemon uninstall` and `muxr integrations uninstall` commands remain available for advanced maintenance.

## Self-host options

```text
muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]
               [--port <n>] [--relay-only|--host-only] [--web] [--yes]
```

The default uses Tailscale when available or the trusted local network otherwise. Session, terminal, attachment, and plugin-stream payloads use the strict v2 E2EE data plane; the relay routes ciphertext it cannot read.

For a shared VPS relay, prefer interactive `muxr`. Automation equivalents are:

```text
muxr shared-relay
muxr machines enroll|list|revoke
muxr connect --enrollment <muxr://enroll?...> [--no-pair|--pair-browser|--pair-both]
```

Enrollment is one-use and five minutes. The VPS retains owner authority; the agent machine generates keys locally and stores only its scoped credential.

## Build a plugin

Bundled and third-party plugins use the same public contract, including bounded app-rendered code and diff views with syntax highlighting—never plugin HTML. Working examples and the full authoring guide ship in `plugins/` and `PLUGINS.md`.

```bash
muxr plugin docs
muxr plugin create <name>
muxr plugin clone <bundled-plugin-id> [destination]
muxr plugin check <path>
muxr plugin dev <path> [--web]
muxr plugin call <path> <contribution-id> [--input '<json>']
muxr plugin list
muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<version>>
muxr plugin update <same-spec>
muxr plugin remove <plugin-id>
```

Apache-2.0. Dependency notices and resolved license inventory are included in `NOTICE`, `LICENSES/`, and `THIRD_PARTY_LICENSES.json`.
