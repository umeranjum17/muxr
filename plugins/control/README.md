# muxr Control extension

The bundled Herdr command surface installed by `muxr setup`. Thin
bootstrap and control-plane only: Herdr never owns the daemon.

- **Host:** runs the bounded muxr control entrypoint from Herdr.
- **Phone (target):** setup/control presentation will move behind muxr's proposed extension host.
- **Authority:** only declared operations are exposed; pairing, E2EE, device revocation, and terminal authority remain kernel-owned.
- **Payload:** `[[build]]` (`build.mjs`) bootstraps the pinned `@trymuxr/cli`
  through the trusted npm release path (or reuses the checkout CLI /
  `MUXR_BIN`). The runtime is never vendored into the plugin dir.
- **Lifecycle:** `[[startup]]` runs `run.mjs start-if-configured`, which kicks
  the already-configured systemd/launchd service and does nothing when muxr is
  not configured. Daemon ownership stays with the OS service; setup remains a
  pane (`muxr setup --from-plugin`).
- **Instance:** every invocation records `HERDR_SOCKET_PATH` / `HERDR_BIN_PATH`
  in `~/.muxr/herdr-plugin.env` (owner-only) so restart and setup target the
  invoking Herdr instance instead of a guessed socket.
- **Updates:** `muxr update` is the single update owner (`--to <version>`
  rolls back); the plugin never updates the CLI itself.
- **State:** uses muxr state under `~/.muxr`; secrets are never returned as UI data.
- **Removal:** `herdr plugin unlink muxr.control` removes the shim only and
  leaves the daemon plus `~/.muxr` intact. Complete removal is
  `muxr uninstall`, whose ordered teardown already exists.
