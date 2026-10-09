# 0007: Herdr is the plugin system; muxr consumes Herdr actions

- Status: accepted
- Tier: T2
- Date: 2026-10-10

## Owner decision

muxr has no plugin system of its own. Herdr is the only plugin system: a
backend that wants to reach muxr installs as a Herdr plugin, and muxr consumes
what Herdr already publishes — Applications (a plugin's global actions become
launchers in Panes) and `muxr.control`. There is no `muxr-ui.json`, no
phone-side manifest catalog, and no `muxr plugin` CLI.

Older phone apps that still call `plugin.*` requests get empty or
"plugins are no longer supported" answers, never a crash. Setup retracts the
registrations of add-ons a previous muxr release shipped and linked; out-of-
install Herdr registrations are never touched.

## Alternatives

- Keep the Pi-like declarative extension runtime of
  [0005](0005-pi-like-extension-runtime.md): rejected. Every product surface
  (voice, usage, attachments, changes, dictation, the terminal key row) had
  become product code, so the runtime carried compatibility cost with no
  shipped plugin.
- A second, smaller muxr-side plugin format: rejected for the same reason —
  it would duplicate Herdr's registry and trust story.

## Evidence

- The runtime, manifest parser, phone plugin tree, plugin CLI and diagnostics
  were deleted in slices 3a–3d (#711, #734, #735, #740) with the suite green.
- Applications and `muxr.control` run on the Herdr socket and were untouched.

## Rollback / reopen trigger

Reopen only if a real third-party surface needs phone UI that Herdr actions
cannot express; that is a new decision, not a restoration of 0005.
