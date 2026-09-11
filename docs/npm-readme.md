# muxr

**Every coding agent, on your phone.** [Website](https://trymuxr.com) · [GitHub](https://github.com/umeranjum17/muxr) · [Quickstart](https://trymuxr.com/docs/quickstart) · [Android APK](https://trymuxr.com/downloads/stable/android) · [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN)

The `@trymuxr/cli` package installs the complete self-hosted CLI, relay, host bridge, plugin runtime, and web client.

## Quickstart

Requires Node 22+. If [Herdr](https://herdr.dev) is missing, setup installs and verifies it automatically.

```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```

`@latest` is the stable CLI and `@nightly` is the newest build. On your computer the two tags are the same CLI, so switching tags replaces the host you already run rather than adding a second one. The Android app is the exception: a nightly installs alongside a stable one, so a phone can carry both.

The convenience installer at `https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh` performs that same npm install without `sudo`; it requires Node 22+ and does not install Node itself.

First run:

1. Run `muxr`. It checks the computer and proposes one ready route: the healthy current route, Tailscale, an existing private network such as NetBird or WireGuard, an installed temporary tunnel, or same Wi-Fi. **Choose another way** reveals every available alternative.
2. Review the short plan and choose **Apply setup**. Setup pairs the browser you are using first: a control grant that expires after eight hours (`--browser-view` for view-only, `--browser-personal` for 30 days on a browser only you use). Pair again when it expires.
3. Optional native apps, which stay paired until revoked: Android from the [stable APK](https://trymuxr.com/downloads/stable/android), verified against the [stable checksum](https://trymuxr.com/downloads/stable/checksums) (save it beside the APK as `SHA256SUMS` and run `sha256sum --ignore-missing -c SHA256SUMS`), or the [nightly channel](https://trymuxr.com/downloads/nightly) with its own checksum; [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app) availability depends on Google review; iOS [TestFlight](https://testflight.apple.com/join/aJSbs8pN) availability depends on Apple review and tester capacity. Scan the one-use QR from `muxr pair`.

Nothing changes before **Apply setup**. Setup then verifies the connection and managed services without printing credentials. Run `muxr pair` anytime for a fresh QR or browser link.

Run `muxr` with no arguments for the interactive setup and maintenance menu. The same menu can host a supervised shared relay on a VPS, create one-use machine enrollments, or connect a local Herdr host using only a machine-scoped credential.

The bundled Usage item sheet runs the exact pinned [ccusage](https://github.com/ccusage/ccusage) backend offline against local coding-agent logs and shows today's allowlisted per-agent token totals without costs, prompts, models, or session details. It also lists every known installed CLI and distinguishes no activity reported today from agents ccusage does not support. npm installs one platform-specific ccusage binary (about 4 MB) for Linux or macOS. Current Codex percentages come from its local app-server; other coding CLIs are PATH-detected but never invoked.

```bash
muxr update                    # check, confirm, update, and restart
muxr update --check            # check without changing anything
muxr --skill                   # print the compact agent skill
muxr skill collaboration       # load one focused reference on demand
muxr doctor                    # current setup health and checked repairs
muxr diagnostics               # bounded redacted host/client history for agents
muxr report > muxr-report.md   # local redacted issue draft; never submits
muxr pair                      # pair another phone (lasts until revoked)
muxr pair --browser            # control browser, expires after eight hours
muxr pair --browser-view       # view-only browser, expires after eight hours
muxr pair --browser-personal   # control for 30 days, for a browser only you use
muxr devices list
muxr devices revoke <number>
```

muxr never installs skills or edits agent instruction files. Run `muxr --skill`
for the compact canonical workflow, then `muxr skill <topic>` only when the
current task needs that reference.

`muxr report` gathers environment versions, doctor check names, and the latest 50 redacted diagnostic events without prompts, terminal output, paths, secrets, or internal ids. It only writes a local draft: review every line, describe what happened, and explicitly decide whether you want to post it. muxr never opens or submits an issue.

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set. Use `muxr setup --dry-run` to preview managed-file changes. `muxr uninstall` removes every muxr-owned operational component—including machine identity, pairings, grants, provider keys, runtime state, services, ingress, and managed integrations—then optionally removes the global CLI. It keeps Herdr, Herdr sessions, repositories, worktrees, received attachments, exports, signing keys, and unrecognized files. The narrower `muxr daemon uninstall` and `muxr integrations uninstall` commands remain available for advanced maintenance.

## Self-host options

```text
muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]
               [--port <n>] [--relay-only|--host-only] [--web] [--yes]
```

Interactive setup keeps the current healthy route, otherwise recommends Tailscale, a detected private overlay, an installed temporary tunnel, or the trusted local network in that order. An inconclusive Tailscale Serve preflight remains advisory; only proven disabled or occupied Serve changes the recommendation. Session, terminal, attachment, and plugin-stream payloads use the strict v2 E2EE data plane; the relay routes ciphertext it cannot read.

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
