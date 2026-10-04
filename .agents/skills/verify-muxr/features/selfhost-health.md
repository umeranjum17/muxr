# Check the self-host

A user checks that their self-hosted muxr is alive, current, and serving
exactly their machine: the relay answers health with its muxr version, and the
owner-only hosts listing shows the host online.

## Sub-features

- `health-identity` `GET /health` reports `ok`, `muxrVersion`, and link protocol.
- `version-match` the relay's `muxrVersion` equals the checkout's package version and the CLI's `--version`.
- `owner-hosts` the owner-only `/relay/v1/hosts` listing shows exactly our host online.
- `port-ownership` the port in use is the one our relay child printed at startup.

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

## Gotchas

- A health probe alone proves nothing about ownership: any stranger's relay on
  another port answers `/health` identically. Always pair it with the stdout
  port line from Launch.
- `muxrVersion` falls back when the package version is `0.0.0`; treat that as
  "unknown build", not a pass.
- The mint secret grants owner authority on this relay; keep it inside the
  run's scratch/evidence paths and never print it into committed artifacts.
