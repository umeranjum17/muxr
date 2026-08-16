# muxr

Control every coding agent on your machine from your phone. The `@trymuxr/cli` package installs the complete self-hosted CLI, relay, host bridge, plugin runtime, and web client.

## Quickstart

Requires Node 22+ and [Herdr](https://herdr.dev). If Herdr is missing, setup asks before installing it.

```bash
npm install -g @trymuxr/cli
muxr setup
```

`muxr setup` inspects the machine, adopts the existing Herdr configuration, installs muxr's bundled plugins, syncs detected coding-agent integrations, starts the relay and host, and displays a short-lived pairing QR plus pasteable pairing string.

```bash
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
