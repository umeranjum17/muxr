# Install and connect your computer

One computer, one browser, a few minutes. Everything below runs on the computer where your coding agents run.

## Requirements

| You need | Because |
|---|---|
| Linux, macOS or WSL | muxr registers a user service there |
| [Herdr](https://herdr.dev) (recommended path) or Node 22+ (npm path) | Herdr runs the agents; the muxr CLI is a Node program |
| For the browser app: an HTTPS route to this computer | browsers only store credentials and open microphones on HTTPS. muxr can provide it through **Tailscale** (Serve), **cloudflared** (temporary tunnel) or **your own HTTPS origin** |
| Same Wi-Fi only, no HTTPS route? | the **native app** pairs with a QR on any route; the browser app waits until one of the routes above exists |

## In Herdr (recommended)

On your computer, in a terminal where `herdr` works:

<!-- herdr-commands:start -->
```text
herdr plugin install umeranjum17/muxr/plugins/control --ref v0.1.28
herdr plugin pane open --plugin muxr.control --entrypoint setup
```
<!-- herdr-commands:end -->

The first command shows what it will run and asks you to confirm. Its build installs the muxr CLI from npm as your user (one exact version, verified, no sudo), records it, and prints the second command. The second command opens the Setup pane inside Herdr.

The plugin is also listed on the Herdr marketplace as **muxr — Start here**. The other muxr entries there are installed by muxr itself; do not install them directly.

## Without Herdr

If you do not use Herdr yet, install the CLI with npm and run it; setup installs Herdr for you.

<!-- npm-commands:start -->
```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```
<!-- npm-commands:end -->

## Setup: check, one route, review, apply

Setup is three interactions on a fresh computer:

1. **Check this computer.** It reads Herdr, your agents and your network routes. Nothing changes.
2. **One recommended route.** Setup proposes the best browser-capable route it found (Tailscale Serve, then cloudflared, then your own HTTPS origin). If it found only a native-only route (same Wi-Fi, a private overlay, direct Tailscale) it says so and names the exact prerequisite for the browser app. **Choose another way** lists every route.
3. **Review, then Apply.** Review shows the plan and the exact `~/.muxr/config.env` it will write. Nothing changes until you choose **Apply setup**. Apply starts the relay and host as a user service, verifies them, and never says "complete" while a check fails.

No add-on, provider or theme question appears before Apply. Those live in [Configuration](configuration.md) and in `muxr` later.

## Pair this browser

After Apply, setup prints one pairing link and its QR. The QR *is* that one-use link, nothing more. Get it into the browser you want to use:

- **Scan it.** On a phone or tablet, open your computer's address in the browser (or the installed app) and tap **Scan QR to pair**; the camera image is read on the device and never leaves it. Your phone's camera app also works: it opens the same pairing page.
- **On the same computer**, open the printed link. **Enter pairing link manually** on the pairing page is the fallback when there is no camera.
- The consent screen names the computer, the access level (**Control** or **View-only**) and the exact expiry. Scanning grants nothing by itself; only **Pair** does.
- **Use this browser** keeps muxr as a tab. **Install** adds it to your home screen or desktop where the browser offers that.
- On an iPhone you can pair in the Safari tab now; if you add muxr to your Home Screen later, the installed app has its own storage and needs its own fresh QR (`muxr pair --browser` on your computer, then **Scan QR to pair** inside the installed app).

Pair another browser or the native app any time:

```bash
muxr pair --browser            # Control, this browser
muxr pair --browser-view       # View-only
muxr pair --browser-personal   # Control for a browser only you use, longer lifetime
muxr pair --native             # the native app: one-use QR
```

Each prints a QR and the link it encodes. Links are one-use and short-lived; the exact lifetimes are in the table below. If one expires while you fetch the phone, the computer prints a fresh QR for the same access level until you press Ctrl-C.

## First useful action

Open the Herd. Tap the agent that **Needs you** and answer it from the composer, or open **Panes → New shell**, run `printf 'muxr-ready\n'`, and watch the exact output appear once in that Herdr pane.

## Verify

```bash
muxr doctor
```

Every row must read `ok`. A failing row names the phase, the cause and the next action; see [Troubleshooting](troubleshooting.md).

<!-- release-facts:start -->
| Fact | Value |
|---|---|
| Current release | `@trymuxr/cli@0.1.28` (tag `v0.1.28`) |
| Minimum Herdr | 0.8.0 |
| Minimum Node (npm path) | 22 |
| Default relay port | 8792 |
| Pairing link | one use, expires in 2 minutes |
| Browser access (Control or View-only) | 8 hours |
| Personal Control (installed browser you own) | 30 days |
| Machine enrollment (shared relay) | 5 minutes |
| Native apps | optional: [Android APK](https://trymuxr.com/downloads/stable/android) ([checksums](https://trymuxr.com/downloads/stable/checksums)), [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app), [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN) — availability depends on store review; [all channels](https://trymuxr.com/downloads) |
<!-- release-facts:end -->

Next: [Daily use](daily-use.md).
