# Self-hosting muxr

Everything muxr does runs on your own infrastructure: the relay, the agent
host, and the pairing between them and the app.

## Quick start

On the machine that runs your agents (Linux, macOS, WSL):

```bash
npm install -g --ignore-scripts @trymuxr/cli
muxr
```

The interactive onboarding inspects the machine without changing it. It shows
all six connection routes together, explains each requirement, and recommends
the healthy current route or a detected route. You then choose
whether to host the control/view-only web client and sync agent integrations.
After a final **Apply setup** confirmation, muxr
starts the selected relay and host, then:

1. Stores strict E2EE relay state under `~/.muxr/relay`.
2. Runs the selected phone, browser, or sequential pairing flow.
3. Reports the selected route, exact `selfhost.json` path, relay URL, web URL when enabled, service health,
   pairing result, and integrations. Credentials and internal IDs are
   never included in this final summary.

muxr never installs skills or edits AGENTS/CLAUDE instruction files. Agents use
muxr guidance only when you explicitly load the self-contained output of
`muxr --skill` (or `muxr skill`). Agent integrations are lifecycle/process
reporting only.

The registered user service supervises the relay and host together, so both
return after login or reboot and `muxr update` restarts them as one managed unit.
Unchanged setup choices keep existing devices paired; changing the endpoint
requires and displays a fresh pairing step.

In the native app: **Scan QR code** or enter the short relay-qualified pairing string. Browser pairing prints one short two-minute HTTPS link. `muxr pair --browser` grants full terminal and agent control; `muxr pair --browser-view` grants explicit view-only access; `muxr pair --browser-personal` grants full control to a browser only you use. Shared browser grants expire after eight hours and personal grants after 30 days, survive refresh/restart, and are reported as paired only after durable browser storage acknowledges the grant.

For automation use `muxr daemon status|logs|start|stop|restart`. Shared relay
automation uses `muxr shared-relay`, `muxr machines enroll|list|revoke`, and
`muxr connect --enrollment …`; interactive `muxr` remains the primary path.

## Reaching the relay from your phone

Interactive `muxr setup` shows one recommended route first. **Other ways**
opens all six routes with their availability and requirements. The current
healthy route is recommended; otherwise setup prefers Tailscale Serve when
available, then direct Tailscale if Serve is proven unavailable, a detected
private overlay, an installed temporary tunnel, or same Wi-Fi. Your own server
remains selectable when you already have a stable WSS endpoint. Unavailable
routes explain what to install or connect before retrying.
Automation uses:

| Flag | What happens |
|---|---|
| `--advertise <url>` | Explicit relay URL wins. Use your own domain/reverse proxy. |
| `--tunnel` | Spawns `cloudflared` for a public `trycloudflare.com` URL. The URL is ephemeral; use a named tunnel for permanence. |
| *(choose Tailscale Serve)* | Uses private HTTPS through `tailscale serve`; the relay stays on loopback. |
| `--tailscale-direct` | Rollback path using the tailnet IP directly. |
| *(detected private network)* | Uses the address on an existing NetBird, WireGuard, ZeroTier, or similar interface. The phone must join that same private network. |
| *(choose Same Wi-Fi)* | Local network address. Phone must be on the same trusted network. |
| *(choose Direct SSH in the Android app)* | Pair through the host's loopback relay over SSH; see [Direct SSH from Android](#direct-ssh-from-android). |

For either Tailscale route, connect the phone to the same tailnet before pairing.
Nearby mDNS discovery is only a locator for an already-paired native app; it
never grants a new device access. A new phone still needs the one-time QR or
pairing string, and the PWA cannot scan local mDNS advertisements.

Before applying Serve, the wizard checks that it is available and not already owned. A timeout or invalid JSON response is inconclusive, so muxr keeps Serve recommended and lets the bounded Apply decide. Only proven disabled or occupied Serve changes the recommendation; muxr then preserves the existing state and offers direct Tailscale.

### Direct SSH from Android

Direct SSH is an Android-native alternative to Tailscale, not a replacement for it. Set it up either way:

- **While pairing:** choose **Connect over SSH** on the pairing screen, enter the machine's SSH details, and paste the pairing string from `muxr pair`. muxr opens the SSH forward first; both the one-time code lookup and pairing claim use that forward, even if the relay URL in the pairing payload is unreachable from the phone. After the grant arrives, muxr saves the SSH route. If the SSH connection drops at any point, **Try again** resumes with the same pairing string in this app session while the code remains valid (up to the two minutes shown by `muxr pair`), including when the relay already answered the lookup or the claim but the answer was lost on the way back. The phone sends a random resume key with its first lookup and claim, and the relay repeats a committed answer only to a request carrying that key (and, for a claim, the same device key), only inside that window and before the grant is fetched, and at most three times per pairing. A repeated claim issues a fresh device credential and retires the lost one. The grant is verified as on a first attempt. A relay older than the phone does not repeat answers: the code then cannot be reused, and muxr says to run `muxr pair` for a fresh one. An expired code likewise needs a fresh one.
- **After pairing:** open **Settings → Connection & updates → Direct SSH** and save the SSH details.

Either way, enter the machine's SSH host, SSH username and port, and the relay port as seen from the machine's loopback (normally `8792`). Choose either a password or an OpenSSH private key; credentials stay in the device secure store and are never written to muxr settings, logs, or the repository. A newly entered credential is checked with a separate SSH sign-in before pairing or replacing a saved credential, even when a tunnel to that host is already open. A rejected credential leaves the live tunnel alone. Use an RSA or ECDSA host key and login key: Ed25519 is not supported by this build yet, and muxr says so explicitly instead of failing to connect.

Once the SSH route is saved, muxr opens a device-local SSH forward to `127.0.0.1:<relay-port>`.
The paired machine's terminal, preview, and plugin-stream connections use that forward alongside sync,
even if its advertised relay URL is unreachable from the phone. The relay ticket, pairing grant,
and E2EE protections stay the same; see [the SSH transport decision](decisions/0006-ssh-loopback-transport.md)
for the routing contract. The desktop can use this route too; see [remote desktop on a cloud server](#remote-desktop-on-a-cloud-server).

Connection & updates also exports and installs the login key. The private key's public half — pasted on that screen or saved on this device — can be copied, shared, or saved as a `.pub` file for any algorithm, including Ed25519. For RSA and ECDSA keys, **Install public key** shows its exact shell command first and runs it only after you confirm: it appends the key to `~/.ssh/authorized_keys` on the paired computer's confirmed SSH account, preserves existing entries and permissions, skips a key that is already present, and records a guarded undo that refuses to roll back if `authorized_keys` changed after the install. Ed25519 stays export-only because the native SSH path cannot use it as a login key. Installation is native-Android only; the browser keeps pairing and relay access and says so instead.

The first successful SSH connection pins the SSH server's `SHA256:` host-key fingerprint on this device. A changed fingerprint blocks the new connection and tells you to review the machine rather than silently trusting a replacement; an already-live tunnel is not closed by this check. The SSH user must be allowed to log in and the muxr relay must be listening on the configured loopback port. PWA and iPhone builds do not show this control because they do not have this native SSH implementation; use Tailscale, a private network, Same Wi-Fi, or your own stable WSS endpoint there.

SSH forwards the loopback relay for pairing and control; it does not authorize a device, replace a grant, or remove E2EE. The desktop picture and controls use WebRTC, not that relay: directly when the phone can reach the computer, or over TCP through a second forward on the same SSH connection when it cannot, so a phone that can reach only SSH (port 22) still views and controls the desktop. Tailscale Serve remains the recommended default because it needs less per-device credential setup and reconnects without a separate SSH session.

### Remote desktop on a cloud server

A cloud server reached only over SSH can show its desktop on the phone: the
Android app carries the picture and controls inside the same SSH connection as
the terminal, so port 22 is the only inbound port the server needs.

1. Install muxr on the server and run `muxr`; the relay stays on its loopback.
2. A server with no screen needs a virtual display once. On Ubuntu 24.04:

   ```bash
   sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb xfce4 xfce4-terminal dbus-x11 libpipewire-0.3-0t64 libxkbcommon0 libevdev2
   ```

   muxr starts a private screen on it when you open the desktop, and again after
   a reboot. If the packages are missing, the phone shows this command.
   On a machine without a Wayland session, muxr uses its X display. To choose
   yourself, set `MUXR_DESKTOP_SOURCE=x11` (optionally with
   `MUXR_DESKTOP_X11_DISPLAY=:99`) or `MUXR_DESKTOP_SOURCE=portal`.
3. Pair the Android app with **Connect over SSH** ([Direct SSH from Android](#direct-ssh-from-android)),
   open an agent, and tap **Computer**.

The prebuilt desktop engine is Linux x64 (glibc 2.36 or newer). An Arm server
needs it [built from source](../packages/desktop-host/README.md#building-from-source).

muxr never enables Funnel. Restrict the Serve endpoint with a tailnet grant/ACL to intended devices even though muxr pairing and E2EE remain authoritative. `--web` requires a secure `wss://` route; insecure LAN HTTP is refused.

Set `MUXR_TRUST_PROXY=1` when the relay sits behind cloudflared/nginx so rate
limits key on real client IPs. The relay keeps at most 10,000 active per-IP
rate-limit windows across HTTP and WebSocket requests. Once full, it rejects
rate-limited requests with new keys until a window expires; existing windows
keep their quotas rather than having them reset.

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

Changing a relay endpoint normally requires fresh pairing because devices pin
the endpoint from their pairing grant. On the same LAN, an already-paired native
app can adopt a discovered address only after verifying it with its saved grant.
Plugin and agent changes sync live and do not require pairing again.

## Updating

Run `muxr` and choose **Update muxr**, or use `muxr update --yes` in automation.
The updater installs the latest npm release, retracts retired plugin registrations, and
restarts a running local relay and host. Source checkouts can instead pull, run
`yarn install --frozen-lockfile && yarn build`, and restart the relay and host.
