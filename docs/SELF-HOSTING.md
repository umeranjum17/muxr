# Self-hosting muxr

Everything muxr does can run on your own infrastructure: the relay, the agent
host, and the pairing between them and the app. No muxr account, no hosted
service, no email provider required.

## Quick start

On the machine that runs your agents (Linux, macOS, WSL), from a muxr checkout:

```bash
yarn install --frozen-lockfile
yarn build
node scripts/cli.mjs self-host
```

When the CLI is published, `npm install -g muxr && muxr self-host` will be the
packaged equivalent.

That one command:

1. Starts your own relay (`~/.muxr/relay`, strict auth, E2EE always on).
2. Prints a **pairing QR code and a raw pairing string**.
3. Waits for your phone, then completes the end-to-end key exchange.

In the app: **Scan QR code** (or paste the pairing string). Done — your machine
shows up and every agent on it is in your pocket.

Start the agent host on the same machine:

```bash
MUXR_MODE=selfhost node scripts/cli.mjs up        # foreground
node scripts/cli.mjs daemon install               # or as a background service
```

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
from the same machine with `node scripts/cli.mjs self-host --host-only` (or
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
