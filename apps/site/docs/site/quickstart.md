# Quickstart

Three steps:

1. **Install on your computer:** `npm install -g @trymuxr/cli@latest`, then run `muxr`.
2. **Get the app:** [Android APK](/downloads/stable/android) or [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN).
3. **Scan the pairing code** that `muxr` shows when setup finishes.

The rest of this page covers each step in detail.

Install muxr—the complete self-hosted CLI, relay, host, and web client—from npm. Your phone connects to your own host and relay over an end-to-end encrypted connection; there is no muxr account, email login, or operated cloud relay:

```bash
npm install -g @trymuxr/cli@latest
muxr
```

Requires Node.js 22+ on Linux, macOS, or WSL. The interactive menu inspects without changing anything. You choose networking, Herdr, integrations, browser hosting, and pairing. A complete plan appears before the Cancel-first Apply gate. The final screen reports relay and web URLs plus service health without printing credentials or internal IDs.

Prefer the guided tour first? See the [setup walkthrough](/docs/setup) with real terminal output for LAN, Tailscale, Cloudflare, a self-hosted VPS relay, and the browser.

## Pair a phone or browser

Android: download the signed [stable APK](/downloads/stable/android), read its [release notes](/downloads/stable/release), and verify it against the published [checksum](/downloads/stable/checksums). [All download channels](/downloads) lists stable and nightly with their exact versions; the nightly Android app installs alongside stable rather than replacing it. Google Play testers can [join the testing track](https://play.google.com/apps/testing/com.trymuxr.app); iOS testers can open the [public TestFlight link](https://testflight.apple.com/join/aJSbs8pN); TestFlight availability depends on review and tester capacity at Apple. Store tracks review and roll out on their own schedule, so their versions are not the channels above. Install an available native app, then scan the QR.

Secure browser hosting is a separate setup choice for Tailscale Serve or a stable external HTTPS/WSS origin; browser pairing prints a clickable HTTPS link and grants read-only access for eight hours.

Run `muxr` again to pair another client, change the connection, update muxr, restart services, or run diagnostics. If you installed muxr before this update, update both the computer CLI and phone app, then pair once again. After that, devices stay paired while the public endpoint is unchanged.

## Peek at your computer

Inside any agent conversation, tap **Computer** to see your computer's screen live and check what the agent is doing right now. Watching is the default. Control starts when you tap: the pointer follows your finger, the phone keyboard types, and copy and paste works in both directions.

It works over a LAN address, any private mesh VPN, or SSH alone. A cloud server that only has port 22 open gets a virtual display, so there is a screen to see. Remote desktop needs a Linux x64 host today; macOS hosts come later.

## One shared relay on a VPS

Run `muxr` on the VPS and choose **Other machines and shared relay → Host a shared relay here**. Use Tailscale Serve or a stable external `wss://` origin, including a named Cloudflare tunnel you configured yourself. The VPS runs a supervised relay-only service with Linux boot persistence and optional read-only web hosting.

Choose **Other machines and shared relay → Create enrollment**. On an agent computer, choose **Other machines and shared relay → Connect this machine to a relay**, and paste the five-minute enrollment string. Keys are generated locally and the agent receives only a revocable credential scoped to that machine. The relay-owner secret never leaves the VPS.

## Automation and diagnostics

```bash
muxr doctor
muxr update --check
muxr pair
muxr pair --browser
muxr machines enroll|list|revoke
muxr connect --enrollment '<muxr://enroll?...>'
muxr daemon status
muxr daemon logs
```

Interactive `muxr` is the primary path; direct commands remain for automation and debugging. muxr supports trusted LAN, direct Tailscale, Tailscale Serve, temporary Cloudflare quick tunnels, and stable external WSS reverse proxies. A manually configured named Cloudflare tunnel works through the external WSS option; muxr does not detect or adopt it. Quick tunnels are excluded from shared VPS relays because their changing URL would strand enrolled machines.

## Linux, macOS, WSL, and SSH

Run muxr where Herdr owns the agents. The agent picker comes from that connected Herdr host, with a clearly labelled offline fallback. For a remote machine, use Tailscale, a stable tunnel, the shared relay flow above, or **Connect over SSH** in mobile Settings.

## Uninstall

`muxr daemon uninstall` removes muxr's service registration and owned ingress. `muxr integrations uninstall` removes only muxr-managed integration files and blocks. Herdr sessions, worktrees, repositories, and muxr data remain intact.
