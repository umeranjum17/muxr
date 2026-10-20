# Keep one host per machine key

Opening or refreshing Usage (and the Home card's `usage.now`) never starts a
second host. In the shipped bundle the Usage ledger child runs `host.js
--muxr-token-ledger`, and `apps/host/src/main.ts` routes that flag to the
ledger before the host can load (0.2.8 ran a whole second host there, which
dialled the relay as this machine and replaced the real one).

If another process does take the link, the replaced host stays up, prints
`link relay: another host is using this machine's key; taking the link back in
30s` and dials again with backoff (30 s doubling to 10 min). `muxr up` exits
non-zero once its host restart budget is spent, so `Restart=on-failure`
restarts the unit.

## Driving it

Preconditions: `yarn build`. Never use `~/.muxr`, the default Herdr or relay
port 8792.

- `node scripts/diagnostics/application/checkUsageKeepsOneHost.mjs`: bundles
  the host as `pack.mjs` does, runs it on a private relay and `MUXR_HOME`,
  seeds one transcript under a lab `CLAUDE_CONFIG_DIR`, pairs a lab device and
  refreshes Usage 5 times. Pass: the seeded turn is counted, no `link relay:
  replaced`, same host pid.
- `checkHostTakeover.mjs`: a second host under the same key takes the link;
  the first stays up, then takes the link back once the second stops.
- `checkHostRestartBudget.mjs`: a host that keeps exiting 0 under `muxr up`
  (private relay port) spends the budget; `muxr up` exits 1.

Release acceptance runs the npm tarball's `cli.mjs up --fake` under a private
`MUXR_HOME`, port and `HOME`: 5 Usage refreshes, 10 minutes idle, an app
reconnect, then zero `replaced` and the same host pid.

## Gotchas

Do not set `HERDR_SESSION` in a lab meant to show the old bug: the 0.2.8 child
host then dies on the missing Herdr before it reaches the relay, and the red
run passes.
