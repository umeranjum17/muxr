# muxr

Control every coding agent on your machine from your phone. The `@trymuxr/cli` package installs the complete self-hosted CLI, relay, host bridge, plugin runtime, and web client.

## Quickstart

Requires Node 22+ and [Herdr](https://herdr.dev). If Herdr is missing, setup asks before installing it.

```bash
npm install -g @trymuxr/cli
muxr
```

The interactive onboarding inspects the machine, then asks you to choose the connection method, Herdr and coding-agent integrations, optional plugins, managed services, browser hosting, and phone/browser pairing. Nothing changes until you review and apply the plan. It then verifies the supervised relay and host and reports the selected relay URL, web URL when enabled, and service health without printing credentials. Native setup displays a QR; browser setup displays a clickable HTTPS pairing link for an eight-hour read-only grant.

Run `muxr` with no arguments for the interactive setup and maintenance menu.

```bash
muxr update                    # check, confirm, update, and restart
muxr update --check            # check without changing anything
muxr doctor                    # redacted setup diagnostics
muxr pair                      # pair another phone
muxr pair --browser            # pair an 8-hour read-only browser
muxr devices list
muxr devices revoke <number>
```

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set. Use `muxr setup --dry-run` to preview managed-file changes. `muxr daemon uninstall` removes only the host registration; `muxr integrations uninstall` removes only muxr-managed integrations. Neither command deletes Herdr work or user repositories.

## Self-host options

```text
muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]
               [--port <n>] [--relay-only|--host-only] [--web] [--yes]
```

The default uses Tailscale when available or the trusted local network otherwise. Session, terminal, attachment, and plugin-stream payloads use the strict v2 E2EE data plane; the relay routes ciphertext it cannot read.

## Build a plugin

Bundled and third-party plugins use the same public contract. Working examples and the full authoring guide ship in `plugins/` and `PLUGINS.md`.

```bash
muxr plugin create <name>
muxr plugin check <path>
muxr plugin dev <path> [--web]
muxr plugin call <path> <contribution-id> [--input '<json>']
muxr plugin list
muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<version>>
muxr plugin update <same-spec>
muxr plugin remove <plugin-id>
```

Apache-2.0. Dependency notices and resolved license inventory are included in `NOTICE`, `LICENSES/`, and `THIRD_PARTY_LICENSES.json`.
