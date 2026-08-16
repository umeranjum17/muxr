# muxr CLI/host

The `muxr` package is not on the public npm registry yet. From a source
checkout use `node scripts/cli.mjs <command>` with the same flags. This file
is the packaged README once `npm publish` happens.

This host-only package connects coding agents running under
[herdr](https://herdr.dev) to muxr. It does not contain the hosted relay
or control-plane source.

```bash
npx muxr setup
```

Interactive setup adopts or installs Herdr, installs the official muxr control
plugin, then hands off to its setup pane. That pane handles connection mode,
pairing, daemon registration, and agent integration sync. If Herdr is missing,
interactive setup asks first and defaults to No; non-interactive setup requires
`--install-herdr`. Use
`MUXR_HERDR_INSTALLER=/path/to/reviewed-installer` with that flag for a local,
reviewed installer. Use `muxr setup --dry-run` to preview all changes and
`muxr doctor` for redacted diagnostics.

`muxr login`, `whoami`, `logout`, and `muxr pair` call the hosted control
plane without callback ports or long-lived secrets in activation URLs. Pairing
prints a five-minute QR/App Link with separate single-use control and E2EE
secrets, pins the machine identity, and completes an authenticated device grant.
Hosted session/RPC, terminal, voice-tool and attachment-chunk traffic is strict
v2 ciphertext; cleartext, unknown versions and legacy downgrade fail closed.

muxr state lives under `~/.muxr` unless `MUXR_HOME` is set; environment variables use the `MUXR_*` prefix.

```text
muxr setup [--mode managed|selfhost] [--inspect] [--dry-run] [--no-agent-config]
           [--install-herdr|--no-install-herdr]
muxr self-host [--advertise <url>] [--tunnel] [--port <n>] [--relay-only|--host-only]
muxr devices list | revoke <number|name>
muxr daemon install|uninstall|start|stop|status|logs
muxr integrations sync [--all] [--dry-run]
muxr integrations uninstall [--dry-run]
muxr doctor
muxr login|pair|whoami|logout
muxr up [--fake]
```

## Write a plugin

`PLUGINS.md` in this package is the authoring guide: manifest shape, every UI
slot, declarative screens, and RPC rules. Working examples ship in `plugins/`.

```
muxr plugin create <name>      scaffold a plugin
muxr plugin check <path>       validate its manifest before installing
muxr plugin dev <path> [--web] validate, link, and optionally open the web app
muxr plugin call <path> <id>   run one of its RPCs from the terminal
muxr plugin list|install|update|remove
```

Product terms are in `LICENSE`; dependency notices and the publish-safe resolved
license/version inventory are in `NOTICE`, `LICENSES/`, and
`THIRD_PARTY_LICENSES.json`. Bundle source paths and esbuild metadata are not
published.
