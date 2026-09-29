# muxr in Herdr (`muxr.control`)

muxr's launcher inside Herdr: setup, pairing, devices, doctor, service
control, logs, update, uninstall and screen-sharing approval, as Herdr actions
and overlay panes. Each one runs a single bounded `muxr` CLI command through
`run.mjs`. The host and relay never run inside Herdr: they stay under
`muxr.service` (launchd on macOS) through `muxr up`, so they keep serving the
phone while Herdr restarts.

## Two ways in, one plugin id

- **npm (`@trymuxr/cli`).** `muxr setup` links this pack from the installed
  package and relinks it when the package moves or the pack version changes.
- **Herdr.** `herdr plugin install umeranjum17/muxr/resources/control --ref vX.Y.Z`
  checks out that release; its build (`build.mjs`) needs Node.js 22+ and installs
  `@trymuxr/cli@X.Y.Z` into the plugin root, where `run.mjs` finds it. Then run the
  `muxr setup` pane. `setup` and `update` see that Herdr owns this checkout and
  never link over it. The `Put muxr on PATH` action links `muxr` into
  `~/.local/bin`.

Herdr refuses to install over a linked copy. To move an npm install to the
Herdr one, unlink first: `herdr plugin unlink muxr.control`, then install.

## Actions and panes

- Actions: start, stop, restart, status, integration-sync, update,
  link-cli, and uninstall / desktop-setup, which open their panes because they
  ask before acting.
- Panes: setup, pair, devices, doctor, service, selfhost, logs, uninstall,
  desktop-setup.

Herdr runs these with its server's environment, not your shell, so `run.mjs`
resolves `MUXR_HOME` explicitly: an exported value, else the one pinned in the
installed service definition, else `~/.muxr`. `muxr doctor` reports whether this
plugin, the CLI and the running host are the same release.

## Update and uninstall

- Update: the `update` action (or `muxr update`). On a Herdr install it
  reinstalls the checkout at the new release tag and restarts the service,
  rolling back to the previous ref if the service does not come back.
- Uninstall has three layers, in this order: the `uninstall` pane
  (`muxr uninstall`) removes the service, ingress, pairings and state; then
  the plugin itself (`herdr plugin uninstall muxr.control` for a Herdr install,
  which the pane offers, or `npm uninstall -g @trymuxr/cli`); finally Herdr's
  own plugin config and state directories, which Herdr never deletes
  (`herdr plugin config-dir muxr.control`).
