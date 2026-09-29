# Cross-side tests

Flows that drive the phone's real modules against the host's: pairing,
link sessions, the shared relay, paired devices, LAN discovery, artifact
transfer and the pairing string. They belong to neither app, so they live here
and not under `apps/` or `scripts/`.

Every host import goes through `host.ts` (or `hostSetup.ts`, which reads the
environment when it loads). When the host moves to its own repository, these
tests stay beside the app. Only those two files change: they read the host from
its pinned published package instead of the workspace. Phone imports stay
relative, and contract and crypto are already pinned packages.

The root vitest config (`yarn run check`'s "unit: all vitest flows") runs them.
The pairing and shared-relay flows also have their own e2e step in `runSuite.mjs`.
The mobile typecheck covers the `*.spec.ts` files through `apps/mobile/tsconfig.json`.
