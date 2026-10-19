# Pair a computer that dials out to the muxr relay

When setup is given an enrollment (`--enrollment` or `MUXR_ENROLLMENT`),
its first route is `Use muxr away from home (your muxr server) · Recommended`:
the computer joins that relay and dials out to it, so nothing on the computer listens on the
network. The phone pairs and works through the relay from any network.

## Sub-features

- `route-default` with an enrollment, step 2 offers `your muxr server` first
  and recommended; its description says nothing on this computer needs to be
  open, and on a first run Enter on it applies (see
  [setup-one-screen](./setup-one-screen.md)). Without one, Tailscale is the
  default.
- `other-ways` `Other ways` still lists Tailscale, private network,
  temporary link and your own server (Wi-Fi only for a computer already on
  it; an enrollment or a saved away-from-home route rules out the plain-computer Wi-Fi recommendation).
- `apply-joins` Apply claims the enrollment (`muxr connect`), starts the
  host, waits for it to come online at the relay and shows the QR and
  pairing string; the menu then reads `relay shared relay in the cloud
  (this host dials out)`.
- `bad-enrollment` an expired or malformed enrollment is a warning in place
  (`…; choose another way below`) and the other routes stay; headless setup
  exits 1 with the reason.
- `loopback-ws` a `ws://` relay is accepted only on loopback (lab and
  same-machine use); any other relay must be `wss://`.

## How to get to it (user POV)

- Computer: run `muxr` with the enrollment from your muxr server -> Enter on
  `your muxr server` -> QR.
- Phone: Scan the QR (or Paste the pairing string) -> Pair -> compare the
  words, press `y` on the computer -> Home shows the computer `connected`.

## Driving it with the private stack

Preconditions:

- A relay from this checkout on a kernel-picked port
  (`MUXR_RELAY_PORT=0`, own `MUXR_RELAY_DATA_DIR`, `MUXR_RELAY_MDNS=0`),
  port taken from its `relay listening on` line.
- An enrollment minted with its `mint-secret`: `POST /v1/selfhost/enrollments`
  `{relay_url:"ws://127.0.0.1:<port>"}` plus `POST /relay/v1/enrolments`,
  joined as `muxr://enroll?payload=base64url({v:1,id,claim,relay,expires,link})`
  (see `tests/cross-side/linkSharedRelay.integration.test.ts`). The link
  token lasts 5 minutes: mint right before running setup.
- A firewall stand-in that changes nothing global: run the computer side in
  `bwrap --dev-bind / / --unshare-net --die-with-parent` (loopback only).
  Its one way out is `socat TCP-LISTEN:<port>,bind=127.0.0.1,fork` inside to
  a Unix socket, and `socat UNIX-LISTEN:<sock>,fork TCP:127.0.0.1:<port>`
  outside. All of setup, the host and the forwarder must share one bwrap.
- `env -i` with `HOME` a lab dir (so the scoped-home guard passes),
  `MUXR_NO_SERVICE_COMMANDS=1`, and a loop that starts
  `MUXR_MODE=selfhost node apps/host/dist/main.js` once
  `~/.muxr/selfhost.json` exists (no service manager runs here).
- A Herdr lab session (`fm-herdr-lab.sh provision`) behind `HERDR_BIN`, with
  `HERDR_SESSION` set to it.
- A phone or emulator that reaches the relay with `adb reverse tcp:<port>
  tcp:<port>`.

- **Route.** Run `muxr`; capture step 2 (route and plan on one screen).
  Step down to `Other ways` and capture the list.
- **Join.** Apply; capture the QR screen and check the host log reads
  `link relay: online`. Inside the namespace, `ip -br addr` shows only `lo`.
- **Pair and use.** Paste the pairing string, Pair, approve the words, start
  an agent and send a prompt; record screenshots every 0.5 s with a step
  log.

## Gotchas

- The `HERDR_BIN` wrapper must run `fm-herdr-lab.sh run` with a PATH that
  does not contain the wrapper itself. Otherwise the helper's own `herdr`
  call loops back into it and adds `--session` twice. The helper also
  forbids `--version` and `status server`, which setup probes; answer those
  in the wrapper (real `herdr --version`; `{"running":true}` for the
  provisioned server).
- `fm-lab-home.sh tmux-dir` refuses a home that is not a marked lab home;
  `create` one first. Check the printed dir is non-empty before starting
  tmux, or tmux lands on the default socket.
- Running the CLI from source, the setup check reports `FAIL host missing
  host runtime` unless cwd is the checkout; a packaged CLI has `host.js`.
  Run `muxr doctor` from the checkout to read the real result.
- The new-agent picker only lists agents on the host's PATH; `env -i`
  hides them. For a no-login agent, link `opencode` into the lab PATH and
  set `opencode/nemotron-3.5-lightning-free` as `model` in the lab session's
  private `config/opencode/opencode.json`.
