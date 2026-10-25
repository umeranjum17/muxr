# Install options

The [README](../README.md#three-commands-to-your-first-agent) has the three-command start.
This page is every other way to install muxr, and the caveats that go with them.

## On your computer

You need **Node.js 22 or newer** on Linux, macOS or WSL, and a coding-agent CLI
installed and signed in on that computer.

```bash
npm install -g --ignore-scripts @trymuxr/cli@latest
muxr
```

`--ignore-scripts` is what the CLI expects: muxr installs and verifies its own
managed pieces during setup, not during `npm install`.

The [convenience installer](https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh)
does the same npm install and hands over to `muxr`:

```bash
curl -fsSL https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh | sh
```

### Nightly builds

The nightly channel is the newest build, published most days. Its phone app and
computer side must be the same version:

```bash
npm install -g --ignore-scripts @trymuxr/cli@nightly
```

then install the [nightly Android APK](https://trymuxr.com/downloads/nightly).
On the computer, `@latest` and `@nightly` are the same install slot, so switching
tags replaces the host you already run instead of adding a second one. A nightly
Android app installs alongside a stable one, so one phone can carry both.

### The Linux desktop app

On Linux the same setup runs in one window: it asks for your project folder
(preselecting a recently modified Git repo it finds, if any), starts the host,
installs Herdr if it is missing, starts at login, can keep the computer awake,
and pairs with your phone by QR or by two words.

```bash
yarn desktop:build:linux
./apps/desktop/release/muxr-*.AppImage
```

A computer without FUSE 2 can only run it as
`./apps/desktop/release/muxr-*.AppImage --appimage-extract-and-run`, and that flag
has to be passed on every launch — so start-at-login needs FUSE 2. The
[download page](https://trymuxr.com/desktop) names the package to install.

The signed Mac build is still to come. From the phone app, **Add your computer**
sends a link and a QR to the desktop download.

## On your phone

- [Android APK](https://trymuxr.com/downloads/stable/android) — open it on the phone to
  install; Android may first ask you to allow installs from your browser or files app.
- [Google Play testing](https://play.google.com/apps/testing/com.trymuxr.app)
- [iOS TestFlight](https://testflight.apple.com/join/aJSbs8pN)

Store testing access depends on review and tester availability. The direct APK does not.

### Verifying a download

Each channel's [download page](https://trymuxr.com/downloads) publishes the APK
next to a checksum file for that exact build. Save the APK and the checksum file
beside it as `SHA256SUMS`, then run:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

Every release is also on the [releases page](https://github.com/umeranjum17/muxr/releases),
with its `signer.txt` and `native-provenance.json` beside the APK.

## Pairing

In the app, paste the private link or pairing code your computer shows and tap
**Connect**, or tap **Scan the QR** where your phone offers it and scan the
computer's one-use QR. Compare the two matching words, then approve on your
computer. Home opens with your agents ready to visit.

To pair another phone later, run `muxr pair` on your computer for a fresh code.

### In a browser

Enable browser access during setup, then run `muxr pair --browser` on your computer
and open its link. That control link lasts eight hours. The web app can be added
to your Home Screen.

## Choosing how the phone reaches the computer

`muxr` shows a short plan under each route it can offer — a local network, a
tunnel, a tailnet, or your own relay — and applies the one you pick when you press
Enter. Nothing changes before that.

[Routes and self-hosting →](SELF-HOSTING.md) · [Step-by-step quickstart →](https://trymuxr.com/docs/quickstart)
