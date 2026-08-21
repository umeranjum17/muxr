# Example muxr UI extension

A combined package that demonstrates the declarative screen vocabulary: list,
detail, and a form, all rendered from `muxr-ui.json` with native muxr
components. Its destination label also demonstrates the bounded localized-text
object (`default` plus BCP-47 translations), so it requires muxr UI 6.

- **Phone:** contributes one top-level **Example** destination. Its screen shows
  a status detail section (metric, badge, progress), a bounded list of recent
  sessions, and a preferences form (text, switch, select fields). The form
  submit button runs through a declared `host.rpc` contribution via
  `plugin.call`; the write RPC (`save`) sends a client idempotency key.
- **Host:** Herdr registers the package identity; muxr reads the `muxr-ui.json`
  sidecar. `rpc.mjs` answers the declared `list` (read) and `save` (write)
  methods. `save` only echoes its bounded input back; it never touches the
  filesystem or reads secrets, so the example is safe to install as-is.
- **Authority:** two read/write RPCs (`list`, `save`) and the
  `example.list`/`example.save` capabilities. No actions, panes, startup hooks,
  data selectors, notification channels, or secrets.
- **Offline:** protocol v1 hides the extension until the host reconnects.
- **Removal:** `herdr plugin unlink example.muxr-ui`.

```bash
herdr plugin link ./plugins/example-ui --enabled
```

This is the rich list/detail/form/RPC/chart reference. `muxr plugin create` intentionally writes a smaller three-file starting point; both exercise the same host validation and public manifest contract.
