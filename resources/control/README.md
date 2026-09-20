# muxr management pane pack

muxr's own management surface for Herdr: setup, pairing, devices, doctor,
service status, and the self-host relay, as Herdr overlay panes.

This pack is part of the product, not an optional plugin. It lives in the muxr
package, is versioned with it, and `muxr setup` installs and keeps it linked.
It declares no muxr UI; Herdr requires a manifest only because a Herdr pane
pack is manifest-shaped. The pane actions run the bounded muxr CLI.

- **Host:** each pane runs one bounded `muxr` CLI command via `run.mjs`.
- **Phone:** the panes appear in Herdr; the phone's muxr surfaces (setup,
  doctor, service) are product screens and never route through a plugin.
- **State:** uses muxr state under `~/.muxr`; secrets are never returned as UI
  data.
- **Removal:** only `muxr integrations uninstall` (or `herdr plugin unlink
  muxr.control`) removes it, because it is not user-optional.
