# muxr Control plugin — Start here

The Herdr plugin that installs and operates muxr. Thin bootstrap and
control plane only: Herdr never owns the daemon.

Install from the exact GitHub source (pin the released ref), then open Setup:

<!-- herdr-commands:start -->
```text
herdr plugin install umeranjum17/muxr/plugins/control --ref v0.1.28
herdr plugin pane open --plugin muxr.control --entrypoint setup
```
<!-- herdr-commands:end -->

- **What the build installs:** `[[build]]` (`build.mjs`) resolves npm
  `latest` for `@trymuxr/cli` to one exact version together with its
  integrity, installs that exact version as the current user (no sudo,
  `--ignore-scripts`), verifies the installed copy reports it, records
  `{ bin, version, source, integrity }` owner-only in
  `~/.muxr/herdr-plugin.runtime`, and prints the Setup-pane command.
  `MUXR_CLI_PIN=<exact version>` is the candidate/test override; `MUXR_BIN`
  is an explicit, always-reported developer override. The runtime is never
  vendored into the plugin checkout.
- **Panes:** Setup, Pair this browser (Control — the default),
  Pair a View-only browser, Pair a personal browser (Control, longer lifetime),
  Pair the native app (QR), Devices, Doctor, Service, shared relay and host
  voice. Every pane runs one declared `muxr` operation through `run.mjs`,
  which executes exactly the recorded runtime and refuses a drifted one
  with the repair command.
- **Lifecycle:** `[[startup]]` runs `run.mjs start-if-configured` once per
  Herdr start: it kicks the already-configured systemd/launchd service and
  does nothing when muxr is not configured. Daemon ownership stays with the
  OS service muxr writes; Herdr does not supervise it.
- **Instance:** every invocation records `HERDR_SOCKET_PATH` /
  `HERDR_BIN_PATH` in `~/.muxr/herdr-plugin.env` (owner-only), so restart
  and setup target the invoking Herdr instance when several exist.
- **Updates:** `muxr update` is the single update owner. It installs the
  target, then moves `herdr-plugin.runtime` to the verified new executable;
  `muxr update --to <version> --allow-downgrade` rolls back the same way. A
  failed install leaves the previous record and runtime in place.
- **State:** everything lives under `~/.muxr`; nothing is written into the
  Herdr plugin checkout, and secrets are never returned as UI data.
- **Removal:** `herdr plugin uninstall muxr.control` removes the managed
  checkout and shim only; the service and `~/.muxr` stay. `muxr uninstall`
  is the bounded operational teardown: it stops and removes the service,
  runtime records, keys and grants, and keeps Herdr sessions, repositories,
  worktrees and received attachments.
