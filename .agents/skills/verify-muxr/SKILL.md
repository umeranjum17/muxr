---
name: verify-muxr
description: Verify muxr's self-hosted relay/host and public CLI the way a user drives them, from this pockit checkout and without touching the owner's installed muxr. Use before claiming a host, relay, Shared Artifacts, naming, retention, or CLI change works, when a check fails and you need a live instance to reproduce against, or when asked to run the verify-muxr flow.
license: Apache-2.0
---

# verify-muxr

Drives a private muxr stack (relay + host + naming loopback) plus the public
`muxr` CLI against disposable state, then captures proof. Everything below was
inspected from this repo's own launch code (`scripts/setup/presentation/up.mjs`,
`scripts/diagnostics/application/checkHostTakeover.mjs`, `scripts/cli.mjs`) and
uses only repo-shipped commands — no new harness.

## Isolation contract (read first)

- Run every command with a task-owned `MUXR_HOME` (never `~/.muxr`) and a
  task-owned relay data dir. Never read, grep, or print `~/.muxr/` or any
  credential file: pairing grants and machine keys live there.
- Strip ambient muxr env before launching, so a lab process can never dial the
  owner's real relay: `unset MUXR_RELAY_TOKEN MUXR_RELAY_URL MUXR_MACHINE_ID MUXR_RELAY_AUTH MUXR_DATA_DIR MUXR_NAMING_PORT`.
- Relay listens on `MUXR_RELAY_PORT=0` (kernel-picked). The bound port is read
  from **our child's own stdout line** `relay listening on wss://…:<port>` —
  that line cannot come from any stranger's process, unlike a health probe.
  This is the repo's own rule (`scripts/diagnostics/application/waitForRelay.mjs`).
- The host runs with `--fake` (the repo's fake development session source, same
  as `yarn host`). It therefore never attaches to a real Herdr session.
- Herdr features that need a pane (`share`, `name`, `preview status`) run inside
  a Herdr pane of a **non-default** session you own. Never touch the `default`
  session, never run `herdr server stop` or any server-wide operation.
- Never touch ports 8792–8793 or any already-listening port; pick your own
  naming port (below) and port 0 for the relay.
- Cleanup kills only the exact PIDs this run started and removes only this
  run's scratch directory. Evidence is written elsewhere and must survive.

## Launch

From the repo root, after `yarn install && yarn build` (needs
`apps/relay/dist/main.js`, `apps/host/dist/main.js`, and
`apps/host/dist/agent/infrastructure/artifactRetention.js` on disk):

```sh
RUN_ROOT="$(mktemp -d /tmp/muxr-verify-XXXXXX)"          # scratch: dies in cleanup
export MUXR_HOME="$RUN_ROOT/muxr-home"
mkdir -p "$MUXR_HOME"
unset MUXR_RELAY_TOKEN MUXR_RELAY_URL MUXR_MACHINE_ID MUXR_RELAY_AUTH MUXR_DATA_DIR MUXR_NAMING_PORT
export MUXR_RELAY_MDNS=0 MUXR_NO_SERVICE_COMMANDS=1

# 1. Relay on a kernel-picked port; the stdout line below is the ownership proof.
MUXR_RELAY_PORT=0 MUXR_RELAY_DATA_DIR="$RUN_ROOT/relay" \
  node apps/relay/dist/main.js >"$RUN_ROOT/relay.log" 2>&1 &
RELAY_PID=$!
RELAY_PORT=""
for _ in $(seq 100); do
  RELAY_PORT="$(sed -n 's/^relay listening on wss\?:\/\/[^:]*:\([0-9][0-9]*\)\s*$/\1/p' "$RUN_ROOT/relay.log" | head -n1)"
  [ -n "$RELAY_PORT" ] && break
  kill -0 "$RELAY_PID" 2>/dev/null || { echo "relay died:"; tail "$RUN_ROOT/relay.log"; exit 1; }
  sleep 0.1
done
[ -n "$RELAY_PORT" ] || { echo "relay never reported its port"; exit 1; }

# 2. selfhost.json pointing the host at OUR relay (mirrors checkHostTakeover.mjs).
RUN_ROOT="$RUN_ROOT" RELAY_PORT="$RELAY_PORT" node --input-type=module -e '
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineIdentity } from "./scripts/setup/index.mjs";
const { RUN_ROOT, RELAY_PORT } = process.env;
const home = join(RUN_ROOT, "muxr-home");
mkdirSync(home, { recursive: true });
const mintSecret = JSON.parse(readFileSync(join(RUN_ROOT, "relay", "mint-secret"), "utf8"));
const machine = { ...machineIdentity(undefined), name: "Verify machine" };
writeFileSync(join(home, "selfhost.json"), JSON.stringify({ version: 1, machine,
  relayPort: Number(RELAY_PORT), relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
  relayLocation: "local", relayRole: "single-machine", connectionMode: "lan",
  webEnabled: false, mintSecret }) + "\n", { mode: 0o600 });
'
OWNER_SECRET="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))' "$RUN_ROOT/relay/mint-secret")"

# 3. Host with the fake session source. Ready when its own log says online.
MUXR_MODE=selfhost MUXR_DATA_DIR="$MUXR_HOME/host" \
  node apps/host/dist/main.js --fake >"$RUN_ROOT/host.log" 2>&1 &
HOST_PID=$!
for _ in $(seq 100); do grep -q 'link relay: online' "$RUN_ROOT/host.log" && break; sleep 0.1; done
grep -q 'link relay: online' "$RUN_ROOT/host.log" || { echo "host never came online:"; tail "$RUN_ROOT/host.log"; exit 1; }

# 4. Naming loopback (only `muxr preview status` needs it). Private fixed port;
#    the default 8797 belongs to the owner's real host.
MUXR_NAMING_PORT=38797 node scripts/naming/server.mjs >"$RUN_ROOT/naming.log" 2>&1 &
NAMING_PID=$!
```

The public CLI for every drive is `node scripts/cli.mjs <command> …` from the
repo root (the tracked source of the installed `muxr` binary), always with the
same `MUXR_HOME`.

## Doctor (read-only)

Run this before driving whenever anything looks off:

```sh
node scripts/cli.mjs --version                                  # CLI identity
node -p "require('./package.json').version"                     # must equal muxrVersion below
curl -fsS "http://127.0.0.1:$RELAY_PORT/health"                 # {"ok":true,"muxrVersion":"…","linkProtocol":1,…}
curl -fsS -H "authorization: Bearer $OWNER_SECRET" \
  "http://127.0.0.1:$RELAY_PORT/relay/v1/hosts"                 # exactly one online host: ours
grep -c 'link relay: online' "$RUN_ROOT/host.log"               # 1
```

Worth driving means: `/health` says `ok`, `muxrVersion` equals the repo version,
the hosts list shows our one host online, and `$RELAY_PORT` came from our
child's stdout (Launch step 1), not from a port scan.

## Drive

Read `features/README.md` first, then the feature file for the behavior you are
verifying. Each file lists exact commands, observable results, and the durable
side effect that proves the feature. Prefer running CLI commands inside a real
Herdr pane you own (so `HERDR_PANE_ID` is set the way users get it) over
synthesizing flags.

## Evidence

Define the run's stable evidence directory up front; cleanup never touches it:

```sh
EVIDENCE="/tmp/verify-muxr-evidence/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$EVIDENCE"
```

Capture, per proof, into `$EVIDENCE` (outside `RUN_ROOT`):

- the command transcript (command line, stdout, stderr, exit code) —
  `… 2>&1 | tee "$EVIDENCE/NN-command.log"; echo "exit=$?" >> "$EVIDENCE/NN-command.log"`,
- the durable side effect, read back through a second user-facing view
  (directory listing, `cmp` against the source bytes, a read-only CLI view),
- environment identity: `node scripts/cli.mjs --version`, the relay `/health`
  body, the git HEAD (`git rev-parse HEAD`), and the owned relay port,
- for a failure-path proof, the exact failing input and its stderr.

Standards: exercise the real user path (public CLI flags, running services) —
never internal setters, test-only endpoints, or mocks standing in for the
feature; the action and the resulting state, not just the final screen; the
side effect verified where it is stored, not only where it is displayed.

## Review evidence standard

Fleet rule: every user-visible change is captured with each changed screen
before/after, in every theme (dark and light) and form factor (phone and
desktop width) the app has, plus one motion recording of each changed
interaction — into the stable `$EVIDENCE` folder above. Applied to this skill:

- Before/after: for each mutation proof, capture the read-only view before
  the command as well as after (e.g. list the artifact timeline, run
  `muxr share`, list again and `cmp` the bytes). A command transcript alone
  is not a complete proof. Name the transcript and state files in the PR.
- Skipped — no themed surfaces: the relay, host, and CLI this skill drives
  render no dark/light UI, so there is nothing to capture per theme.
- Phone app form factors are a separate surface with their own verification.
  Terminal dimensions do affect pairing QR admission: `features/pairing-qr.md`
  captures normal/narrow grids and an isolated Herdr terminal before/after.
- Skipped — no motion: CLI output is text with no transitions or gestures,
  so there is no interaction to motion-record; the command transcript
  (`NN-command.log` with stdout, stderr, and exit code) is the equivalent
  capture.

## Cleanup

```sh
kill "$NAMING_PID" "$HOST_PID" "$RELAY_PID" 2>/dev/null    # exact PIDs this run started
wait "$NAMING_PID" "$HOST_PID" "$RELAY_PID" 2>/dev/null
rm -rf "$RUN_ROOT"                                         # scratch only
ls "$EVIDENCE"                                             # proof must still exist
```

Close any Herdr workspaces/panes this run created, then stop and delete only
the non-default session you created. Never kill by process name. Never remove
the evidence directory. If a drive failed midway, run this same cleanup before
retrying so broken attempts strand no processes or ports.
