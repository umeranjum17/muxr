# Listening ports

See what is listening on this machine and stop it from your phone.

- **Phone:** a top-level **Ports** destination. Tap a row for process detail and a stop button.
- **Host:** `list` / `detail` (read) and `stop` (write) RPCs.
- **Authority:** `stop` is a write-mode RPC. Approving this plugin lets the phone kill the reported process as the host user.
- **Offline:** hidden until the host reconnects.
- **Removal:** `herdr plugin unlink muxr.ports`.
