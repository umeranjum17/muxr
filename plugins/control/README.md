# muxr Control extension

The bundled Herdr command surface installed by `muxr setup`. Thin
bootstrap and control-plane only: Herdr never owns the daemon.

- **Host:** runs the bounded muxr control entrypoint from Herdr.
- **Phone (target):** setup/control presentation will move behind muxr's proposed extension host.
- **Authority:** only declared operations are exposed; pairing, E2EE, device revocation, and terminal authority remain kernel-owned.
- **Payload:** `[[build]]` (`build.mjs`) installs one exact `@trymuxr/cli`
  through the trusted npm release path — explicit `MUXR_BIN` wins, otherwise
  the installed `muxr version` must equal the pin (explicit exact
  `MUXR_CLI_PIN`, else the checkout root `package.json` version). The runtime
  is never vendored into the plugin dir, and a bare repo/subdir checkout
  without a built tree still resolves its pin instead of skipping.
- **Lifecycle:** `[[startup]]` runs `run.mjs start-if-configured`, which kicks
  the already-configured systemd/launchd service and does nothing when muxr is
  not configured. Daemon ownership stays with the OS service; setup remains a
  pane (`muxr setup --from-plugin`).
- **Instance:** every invocation records `HERDR_SOCKET_PATH` / `HERDR_BIN_PATH`
  in `~/.muxr/herdr-plugin.env` (owner-only). Daemon install captures
  `HERDR_SOCKET_PATH` into the unit (live env first, then that file), so
  restart and setup target the invoking Herdr instance instead of a guessed
  socket.
- **Updates:** `muxr update` is the single update owner (`--to <version>`
  rolls back where the installed CLI supports it); the plugin never updates
  the CLI itself.
- **State:** uses muxr state under `~/.muxr`; secrets are never returned as UI data.
- **Removal:** `herdr plugin unlink muxr.control` removes the shim only and
  leaves the daemon plus `~/.muxr` intact. Complete removal is
  `muxr uninstall`, whose ordered teardown already exists.
