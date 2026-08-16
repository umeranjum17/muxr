# muxr Run Server extension

A bundled Herdr plugin that starts the selected project's existing `dev` script and contributes a generic source-driven `item-list` in the session header.

- **Start:** the declared Herdr action runs the project's package-manager `dev` script with explicit pane context.
- **Discovery:** `rpc.mjs list` consumes only the host-injected `cwd`, reads Linux `ss` or macOS `lsof`, resolves listener process directories, keeps only the selected project/root relationship, probes loopback HTTP with strict caps/timeouts, deduplicates ports, and returns generic rows.
- **Phone:** the item-list polls every 15 seconds only while mounted/active, hides when no rows exist, and force-refreshes on open.
- **Action:** each row emits `{ "type": "kernel.navigate", "target": "preview", "port": ... }`; no URL, PID, pane id, or other internal id reaches the renderer.
- **State:** the start action writes a local log and stores no credentials.
- **Removal:** `herdr plugin unlink muxr.run-server`.

Loopback proxying, `preview.list` fallback, `preview.attach`, relay authority, and browser/WebView policy remain compiled kernel transport substrate. Generic primitives never call them directly.
