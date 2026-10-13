# Check the self-host

A user checks that their self-hosted muxr is alive, current, and serving
exactly their machine: the relay answers health with its muxr version, and the
owner-only hosts listing shows the host online.

## Sub-features

- `health-identity` `GET /health` reports `ok`, `muxrVersion`, and link protocol.
- `version-match` the relay's `muxrVersion` equals the checkout's package version and the CLI's `--version`.
- `owner-hosts` the owner-only `/relay/v1/hosts` listing shows exactly our host online.
- `port-ownership` the port in use is the one our relay child printed at startup.
- `headless-configuration` configure-only writes private, repeatable state without starting anything; foreground `muxr up` owns the relay and serves a paired phone.

## How to get to it (user POV)

- Open the relay's health endpoint in a browser or with curl: `http://127.0.0.1:<port>/health`.
- Run `muxr status` (same surface as `muxr doctor`) against the machine's setup.
- From the owner shell, list online hosts on the relay.

## Driving it with the private stack

Preconditions:

- Baseline stack from `../SKILL.md` is up (`RELAY_PORT`, `OWNER_SECRET` exported).

- **Health identity.** `curl -fsS "http://127.0.0.1:$RELAY_PORT/health"` exits `0`
  and returns a JSON body containing `"ok":true`, `"muxrVersion"`, and
  `"linkProtocol":1`, plus live counters (`uptimeMs`, `connectedPeers`,
  `onlineMachines`).
- **Version match.** `node scripts/cli.mjs --version` and
  `node -p "require('./package.json').version"` both print the same string as
  the `muxrVersion` field. A mismatch means the running build is not the
  checkout — stop and rebuild before driving anything else.
- **Owner hosts.** `curl -fsS -H "authorization: Bearer $OWNER_SECRET" "http://127.0.0.1:$RELAY_PORT/relay/v1/hosts"`
  returns a `hosts` array with exactly one entry whose `id` matches the
  machine identity written into `selfhost.json` and `online` is true.
- **Unauthorized is refused.** The same hosts call without the bearer token
  fails (`curl -fsS` exits non-zero); the listing is owner-only.
- **Port ownership.** `grep 'relay listening on' "$RUN_ROOT/relay.log"` shows
  the same port the calls above used — the port came from our child's stdout,
  never from scanning.

### Headless cloud configuration (clean-container recipe)

This path replaces the baseline Launch: use a fresh Debian/Ubuntu Node 22
container, the package built from the candidate checkout, its own HOME and
MUXR_HOME, and Herdr installed **inside** the container. Do not mount host HOME,
credentials, Herdr sockets, or systemd. The desktop's existing Tailscale is only
used as an advertised route; do not change its auth or network configuration.
Choose a task-private unused port, never 8792–8793; host networking is permitted
when the emulator must reach the desktop's tailnet address. All `muxr up`
commands below run inside the container, never on the desktop.

1. **Before:** install the main package in a fresh container. With no state,
   `MUXR_MODE=selfhost muxr up` exits nonzero for missing `selfhost.json`.
   Retain stderr and exit code, then remove only that owned container.
2. **Configure:** install the candidate package in another fresh container.
   Set the same HOME/MUXR_HOME for all commands. Run non-interactively:
   `muxr self-host --configure-only --advertise ws://<tailnet-address>:<port> --port <port>`.
   It exits 0, says no relay/service started, and directs the operator to
   `MUXR_MODE=selfhost muxr up` and then `muxr pair` in another shell.
3. **Private, idempotent state:** verify `selfhost.json` and `relay/mint-secret`
   are owner-only files, with relay port/URL and the resolved tailnet IPv4 bind
   (`100.64.0.0/10`). Only plain `ws://` is accepted and stores private mode; `wss://` is refused. Never print
   keys/tokens. Hash both files and record mtimes inside the container; rerun
   the identical command and assert those values are unchanged. Check the
   container process list and private service directories: no relay, host,
   Tailscale invocation, or muxr service was created by configuration.
4. **Foreground runtime:** run `MUXR_MODE=selfhost muxr up` in a dedicated
   shell pane inside the container. Keep any host HTTP/naming ports private
   too. Record the owned relay child's startup port and require the matching
   `/health` to report the candidate version and an online machine through
   the tailnet address. Correlate the child's socket inode with an IPv4
   `<tailnet-address>:<port>` LISTEN row in `/proc/net/tcp` (or `ss`). Require
   connection to the container's non-tailnet address on that port to fail.
   Before the tailnet address is assigned, require a live foreground process,
   the clear `waiting for Tailscale address` line and no relay; when the address
   appears, the same process starts its relay. Never change shared host networking
   to manufacture this case: use an owned network namespace or authorized cloud
   machine. Observe the same foreground process and child for two
   minutes, with no restart log or restart-loop; no detached relay exists.
5. **Native pairing:** hold the shared emulator lock for the whole bounded
   journey (`flock -o -w <seconds> /tmp/fm-muxr-emulator.lock <command>`, at
   most 30 minutes). Boot a task-owned emulator under the memory gate with
   private AVD storage; every adb call uses its explicit serial. Install muxr,
   mint a fresh offer with `muxr pair` inside the running container and pair
   through the app's normal consent flow. Keep the offer only in private
   task scratch; do not include it in logs/screenshots. Verify it advertises
   the tailnet address (no adb reverse of the relay port or loopback rewrite).
   Reach Home and start a shell pane, then capture settled Home and terminal
   at 270 dp and 393 dp. Open every capture and check for clipped or hidden
   controls and internal IDs. Keep captures and sanitized command/results
   outside scratch; report the exact APK identity and limitations.
6. **Cleanup:** stop the exact owned emulator, foreground host/container and
   development servers. Delete task scratch, not evidence. Any desktop Herdr
   lifecycle needed for shell panes must use the dispatch brief's guarded lab
   helper, including teardown/tripwire checks; container Herdr stays inside.

A CLI-only or browser-only check does not prove native pairing. A foreign relay
health response does not prove the foreground process owns it. A missing
container/emulator precondition is an explicit unperformed proof, not a PASS.

## Gotchas

- A health probe alone proves nothing about ownership: any stranger's relay on
  another port answers `/health` identically. Always pair it with the stdout
  port line from Launch.
- `muxrVersion` falls back when the package version is `0.0.0`; treat that as
  "unknown build", not a pass.
- The mint secret grants owner authority on this relay; keep it inside the
  run's scratch/evidence paths and never print it into committed artifacts.
