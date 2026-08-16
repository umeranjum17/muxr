# Self-hosting muxr

Everything muxr does runs on your own infrastructure: the relay, the agent
host, and the pairing between them and the app.

## Quick start

On the machine that runs your agents (Linux, macOS, WSL):

```bash
npm install -g @trymuxr/cli
muxr setup
```

Setup adopts or installs Herdr with consent, syncs detected agent integrations,
starts your relay and host, then:

1. Stores strict E2EE relay state under `~/.muxr/relay`.
2. Prints a **pairing QR code and a raw pairing string**.
3. Waits for your phone, then completes the end-to-end key exchange.

In the app: **Scan QR code** (or paste the pairing string). Done — your machine
shows up and every agent on it is in your pocket.

For manual service control use `muxr daemon status|logs|start|stop`. Advanced
split deployments can use `muxr self-host --relay-only` and
`muxr self-host --host-only`.

## Reaching the relay from your phone

`muxr self-host` picks an advertise address in this order:

| Flag | What happens |
|---|---|
| `--advertise <url>` | Explicit relay URL wins. Use your own domain/reverse proxy. |
| `--tunnel` | Spawns `cloudflared` for a public `trycloudflare.com` URL. The URL is ephemeral; use a named tunnel for permanence. |
| *(Tailscale detected)* | Uses private HTTPS through `tailscale serve`; the relay stays on loopback. |
| `--tailscale-direct` | Rollback path using the tailnet IP directly. |
| *(fallback)* | LAN address. Phone must be on the same network. |

muxr never enables Funnel. Restrict the Serve endpoint with a tailnet grant/ACL to intended devices even though muxr pairing and E2EE remain authoritative. `--web` requires a secure `wss://` route; insecure LAN HTTP is refused.

Set `MUXR_TRUST_PROXY=1` when the relay sits behind cloudflared/nginx so rate
limits key on real client IPs.

## Pairing, security model

- The relay enforces end-to-end encryption (v2 machine keys). Terminal output,
  keystrokes, prompts, and files are sealed on your machines; the relay routes
  ciphertext it cannot read.
- Pairing is single-use and expires in five minutes. The QR/pairing string
  carries a one-time claim, a pair secret, and your machine's public key. The
  pair secret never touches the relay.
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

That binds port 8792 and stores relay state in the `relay-data` volume. Pair
from the same machine with `muxr self-host --host-only` (or
point `--advertise` at the container's published URL). Set `MUXR_TRUST_PROXY=1`
in `docker-compose.yml` when a reverse proxy sits in front.

`nixpacks.toml` is a Railway leftover that installs `unzip` for the relay image;
it is not a second product. Use the Dockerfile.

## Multiple machines

Run `muxr self-host` on each box. The app keeps every paired machine in
Settings and routes agents to whichever you select. Each machine has its own
relay, its own keys, its own device list.

## Updating

Pull the checkout, `yarn install --frozen-lockfile && yarn build`, then restart
the relay and host. When the CLI is published, `npm update -g muxr` will be the
packaged equivalent.
