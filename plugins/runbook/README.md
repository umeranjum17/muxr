# Runbook

Saved commands you can run on your machine from your phone.

- **Phone:** a top-level **Runbook** destination. Each saved command has a run button.
- **Host:** `list` / `detail` (read) and `run` (write). `run` is `execSync` of the saved string as the host user — a bundled remote shell for commands you chose to save. State lives in `$MUXR_PLUGIN_STATE_DIR/commands.json` and is refused if that directory is missing.
- **Authority:** write-mode execution. Pairing plus this plugin is equivalent to running those commands at your own prompt.
- **Offline:** hidden until the host reconnects.
- **Removal:** `herdr plugin unlink muxr.runbook`.
