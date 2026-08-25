# Self-hosting muxr

Everything muxr does runs on your own infrastructure: the relay, the agent
host, and the pairing between them and the app.

## Quick start

On the machine that runs your agents (Linux, macOS, WSL):

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

The interactive onboarding inspects the machine without changing it. You choose
the connection method, local port or external URL, whether to host the control/view-only
web client, agent integrations, optional plugins, and managed services. After a
final **Apply setup** confirmation, muxr starts the selected relay and host, then:

1. Stores strict E2EE relay state under `~/.muxr/relay`.
2. Runs the selected phone, browser, or sequential pairing flow.
3. Reports the connection mode, relay URL, web URL when enabled, service health,
   pairing result, integrations, and plugins. Credentials and internal IDs are
   never included in this final summary.

muxr never installs skills or edits AGENTS/CLAUDE instruction files. Agents use
muxr guidance only when you explicitly load the self-contained output of
`muxr --skill` (or `muxr skill`). Agent integrations are lifecycle/process
reporting only.

The registered user service supervises the relay and host together, so both
return after login or reboot and `muxr update` restarts them as one managed unit.
Unchanged setup choices keep existing devices paired; changing the endpoint
requires and displays a fresh pairing step.

In the native app: **Scan QR code** or enter the short relay-qualified pairing string. Browser pairing prints one short two-minute HTTPS link. `muxr pair --browser` grants full terminal and agent control; `muxr pair --browser-view` grants explicit view-only access. Both browser grants expire after eight hours, survive refresh/restart, and are reported as paired only after durable browser storage acknowledges the grant.

For automation use `muxr daemon status|logs|start|stop|restart`. Shared relay
automation uses `muxr shared-relay`, `muxr machines enroll|list|revoke`, and
`muxr connect --enrollment …`; interactive `muxr` remains the primary path.

## Reaching the relay from your phone

Interactive onboarding presents these choices. The equivalent automation flags
are:

| Flag | What happens |
|---|---|
| `--advertise <url>` | Explicit relay URL wins. Use your own domain/reverse proxy. |
| `--tunnel` | Spawns `cloudflared` for a public `trycloudflare.com` URL. The URL is ephemeral; use a named tunnel for permanence. |
| *(choose Tailscale Serve)* | Uses private HTTPS through `tailscale serve`; the relay stays on loopback. |
| `--tailscale-direct` | Rollback path using the tailnet IP directly. |
| *(choose Local network)* | LAN address. Phone must be on the same network. |

muxr never enables Funnel. Restrict the Serve endpoint with a tailnet grant/ACL to intended devices even though muxr pairing and E2EE remain authoritative. `--web` requires a secure `wss://` route; insecure LAN HTTP is refused.

Set `MUXR_TRUST_PROXY=1` when the relay sits behind cloudflared/nginx so rate
limits key on real client IPs.

## Pairing, security model

- The relay enforces end-to-end encryption (v2 machine keys). Terminal output,
  keystrokes, prompts, and files are sealed on your machines; the relay routes
  ciphertext it cannot read.
- Native pairing is single-use and expires in two minutes. QR and manual entry
  use the same short value, for example `wss://relay.example?pair=7KDM4-QXP7N`.
  The relay stores only a code hash and code-encrypted payload, deletes the
  lookup on first resolution, and never receives the code or pair secret.
- The phone proves itself once and receives a durable device credential. It remains paired until explicit revocation; normal calendar time never forces another QR.
- Never edit relay state by hand. List and revoke phones with:

  ```bash
  muxr devices list
  muxr devices revoke 2       # list number, or an unambiguous friendly name
  ```

  Revocation immediately closes that phone's sockets and credential, rejects its unused tickets, removes its ingress key, then rotates the machine data key and every remaining device's ingress key.
- Ticket minting is gated by a mint secret (`~/.muxr/relay/mint-secret`, owner-only
  file). Reading that file is what "same machine" means — a reverse proxy in
  front of the relay cannot mint tickets.

## Your own email provider

Self-host pairing needs no email at all. If you want notification emails from
your own relay, set `MUXR_EMAIL_PROVIDER=resend` + `MUXR_RESEND_API_KEY` +
`MUXR_EMAIL_FROM` — the `NotificationEmail` interface (`apps/relay/src/email.ts`)
is the seam other providers (SMTP etc.) plug into.

## Docker relay

The [Dockerfile](../Dockerfile) is a relay-only image. From the repo root:

```bash
docker compose up
```

That binds port 8792 and stores relay state in the `relay-data` volume. The
interactive shared-relay flow is preferred because it adds machine-scoped
enrollment; do not copy the relay mint secret or its data volume onto agent
machines. Set `MUXR_TRUST_PROXY=1` in `docker-compose.yml` when a reverse proxy
sits in front.

The relay image additionally installs `unzip` via `nixpacks.toml` (an Expo
native dependency needs it at install time). The Dockerfile is the supported
path.

## Shared relay on a VPS

Run interactive `muxr` on the VPS and choose **Host or change a shared relay**.
Choose Tailscale Serve, Cloudflare, or your external `wss://` reverse proxy,
optionally host the control/view-only web client, review the plan, and Apply. The VPS
runs only the supervised relay; it does not need Herdr or an agent host.

Choose **Manage shared relay machines → Create enrollment**. The resulting
string is single-use, expires after five minutes, and contains the relay URL plus
one-time bootstrap material. It never contains relay-owner authority.

On each agent machine, run interactive `muxr`, choose **Connect to a shared
relay**, and paste that string. Machine keys are created locally. The relay
derives the machine identity from its signing key and returns only a credential
scoped to that machine. The local Herdr host connects outbound, then setup offers
native, control-browser, and view-only browser pairing.

Use **Manage shared relay machines** on the VPS to list or revoke machines by
friendly name or list number. Revocation immediately invalidates unused tickets,
disconnects the host and its devices, and cannot affect another enrolled machine.
The relay still routes E2EE ciphertext only.

Changing a relay endpoint requires fresh pairing because existing devices pin
the endpoint from their pairing grant. Plugin and agent changes sync live and do
not require pairing again.

## Updating

Run `muxr` and choose **Update muxr**, or use `muxr update --yes` in automation.
The updater installs the latest npm release, refreshes bundled plugins, and
restarts a running local relay and host. Source checkouts can instead pull, run
`yarn install --frozen-lockfile && yarn build`, and restart the relay and host.
