# Setup walkthrough

Every path through muxr setup has the same shape: **inspect → choose → review → apply**. The wizard never changes your machine during inspection. A first run shows its short plan under the route choice, and Enter on a route applies it; changing an existing setup lists everything it is about to touch and waits for **Apply setup**.

This page shows what that actually looks like, for each kind of machine.

## Pick your connection

- **Most people: Tailscale on the phone and the computer, signed in to the same account:** Scenario 1.
- **A quick public address, no domain:** Scenario 2.
- **Several computers behind one server you own:** Scenario 3.
- **A cloud server you reach only over SSH:** in the app, open Settings → **Connect over SSH**. Only port 22 has to be reachable, and the server gets a virtual display for remote desktop.
- **A browser instead of the app:** Scenario 4.

## The inspection

Install once, then run the wizard:

```bash
npm install -g @trymuxr/cli@latest
muxr
```

The first thing you see is the inspection. Real output (from a machine with Herdr, Tailscale, and Cloudflare available):

```text
  ███╗   ███╗██╗   ██╗██╗  ██╗██████╗
  ██╔████╔██║██║   ██║ ╚███╔╝ ██████╔╝
  ██║╚██╔╝██║██║   ██║ ██╔██╗ ██╔══██╗
  ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝

  Your agents. One pocket.

◆ Checking this machine
  ● Herdr herdr 0.8.0
  ● Herdr server running
  ● Agent integrations 13 ready — pi, omp, claude, codex, devin…
  ● Tailscale connected — 100.x.y.z
  ● Cloudflare Tunnel available
  ● Local network 192.168.1.20

◆ Inspection complete. Nothing changed.
```

Read-only, always. You can also run this exact step non-interactively with `muxr setup --inspect`.

## Scenario 1: Tailscale (the default)

The recommended path, and the only one a first run offers up front. Install the free Tailscale app on your phone and your computer and sign in to the same account. If Tailscale is missing or not connected on the computer, setup says so in one sentence and **Check again** looks once more, without leaving the screen. A private network you already run (NetBird, WireGuard) is under **Other ways**.

1. Run `muxr` on the computer. Step 2 of 3 asks how your phone reaches it, with **Use muxr away from home (Tailscale)** already selected.
2. Press Enter. muxr asks Tailscale to serve the local relay over your tailnet's HTTPS name (`wss://your-machine.tail-scale.ts.net`) — it does not create users, change ACLs, or touch other services. Nothing changes before that Enter.
3. Scan the QR on the phone (which must have Tailscale on).

Why Serve instead of the direct IP: its secure endpoint also qualifies for browser hosting later. If Serve is unavailable here, setup recommends the phone-only Tailscale route instead; if you only ever want the native app, pick it under **Other ways**.

## Scenario 2: Temporary Cloudflare tunnel

For quick public access without configuring a domain.

1. Install `cloudflared`; no Cloudflare account or tunnel configuration is required.
2. Run `muxr`, choose **Set up or repair this machine**, then **Change networking and integrations**.
3. Connectivity: **Cloudflare tunnel**. The plan explains that muxr will start a tracked quick tunnel and obtain a temporary `trycloudflare.com` address.
4. Review and **Apply setup**.

The wizard does not detect or adopt named Cloudflare tunnels. For a stable domain, configure the named tunnel or reverse proxy yourself, then choose the external WSS option and enter its `wss://` origin. Quick tunnels are deliberately excluded from shared-relay setups because their changing URL would strand enrolled machines.

## Scenario 3: Your own VPS as a shared relay

Several computers, one relay you own, phone pairs once per machine. The relay routes encrypted envelopes and can never read them.

**On the VPS:**

1. `npm install -g @trymuxr/cli@latest && muxr`
2. Choose **Other machines and shared relay**, then **Host a shared relay here**.
3. Give it a stable `wss://` origin: Tailscale Serve on the VPS, or an external reverse proxy or named Cloudflare tunnel you configured yourself.
4. The VPS runs a supervised, relay-only service. No agent runtimes, no Herdr, no credentials for your machines.

**Then, for each agent computer:**

1. On the VPS: open **Other machines and shared relay → Create enrollment**. You get a five-minute, single-use enrollment string.
2. On the agent computer: open **Other machines and shared relay → Connect this machine to a relay**, then paste the string.
3. The machine generates its keys locally, proves possession, and receives a revocable credential scoped to that one machine. The relay-owner secret never leaves the VPS.

Enrolled machines are isolated from each other; revoking one never touches the others. Each phone pairs to each machine independently — one phone, many machines; one machine, many phones.

## Scenario 4: Read-only browser

Any scenario that ends in `https://`/`wss://` (Tailscale Serve, Cloudflare, or your own reverse proxy) can also host the web client. LAN `ws://` cannot — browsers require a secure origin.

1. During setup, choose **Host the browser client**, then **Browser**.
2. After Apply, the wizard prints a clickable pairing link.
3. Open it in any modern browser. The browser generates its own keys, stores them in a non-extractable IndexedDB key, and receives an **eight-hour, read-only** grant.

Read-only means exactly that: terminals render in observe mode, and input, prompts, agent control, plugin actions, and voice are refused server-side. When the grant expires, pair again — or don't; it's a convenience surface, not a second authority.

## After Apply

The wizard ends with health checks and a sanitized summary:

```text
  ok    node             v26.1.0
  ok    host             host runtime present
  ok    herdr            herdr 0.8.0
  ok    integrations     pi:current
  ok    connection       tailscale-serve · wss://your-machine.tail-scale.ts.net
  ok    host service     running and authenticated

muxr setup checks passed.
```

On a Tailscale route it then prints this computer's **one pairing link** and its QR: open it on the phone and tap Pair. The link stays the same (run `muxr link` to see it again); keep it private. On other routes it draws a **one-use, five-minute pairing QR** in the terminal. The QR is a bootstrap, not your data: keys are generated on both devices, the exchange is encrypted, and everything after syncs over E2EE. If it expires, run `muxr pair` for a fresh one.

The summary shows endpoints and health. It never prints credentials, keys, machine secrets, or internal IDs.

## Changing your mind

Run `muxr` again. Re-running with the same choices is a no-op — working services are not restarted. Changing the endpoint (for example LAN → Tailscale Serve) re-pairs devices, because pairing binds to an endpoint. Agent changes and Herdr plugins you add or remove show up live (plugins under Applications), with no re-pair needed.

Other doors back in:

- `muxr doctor` — the health output above, on demand
- `muxr update --yes` — update the CLI and restart services
- `muxr pair --browser` — new eight-hour browser grant
- `muxr daemon uninstall` — remove muxr's services; your Herdr sessions and repos stay
