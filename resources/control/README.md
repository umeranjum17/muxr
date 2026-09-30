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

## Canonical source and marketplace mirror

This directory owns the `muxr.control` manifest and launcher. The npm release
ships it unchanged in `@trymuxr/cli/resources/control`. Change the launcher
here; the `umeranjum17/muxr-herdr` marketplace repository is a distribution
mirror, so people can still install it through herdr.dev/plugins.

This is preparatory work: the mirror check is not currently enforced. A queued
follow-up in `umeranjum17/muxr-herdr` will enable it on pull requests and pushes
after the CLI release containing this verifier publishes. That follow-up must
install the same exact CLI version its build installs, then run the verifier
shipped in that package from the mirror's root:

```sh
npm install --prefix .canonical --no-save --ignore-scripts --no-audit --no-fund @trymuxr/cli@X.Y.Z
node .canonical/node_modules/@trymuxr/cli/resources/control/check-copy.mjs .
```

Replace `X.Y.Z` with the mirror's pinned release version. A missing or different
manifest fails the check. To update the mirror for a release, generate its
manifest and commit it with the CLI version update:

```sh
node .canonical/node_modules/@trymuxr/cli/resources/control/check-copy.mjs --write .
node .canonical/node_modules/@trymuxr/cli/resources/control/check-copy.mjs .
```

The generated manifest points every CLI action and pane at
`./node_modules/@trymuxr/cli/resources/control/run.mjs`, where the mirror's build
installs the package. The canonical pack keeps its local `./run.mjs` path. Do
not copy the canonical manifest verbatim or edit the mirror's actions, panes or
version independently. This checks the immutable release the mirror installs,
without depending on the current pockit branch or changing the canonical launcher.
