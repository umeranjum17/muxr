# Add your computer from the phone

A person with only the phone app taps **Add your computer**. The phone shows a
link (`<public site>/desktop`) and its QR, with Copy and Share. They open it on
the computer, and the site's `/desktop` page offers the Linux desktop app.
After they open the app, they scan the computer's own QR with today's
pairing flow (consent, two words, Approve on the computer). The link carries no
pairing offer, and the CLI install stays where it was. The page offers
the AppImage only when the stable release catalog carries a validated `linux`
asset; until then it says the download isn't published yet and shows the
terminal install.

## Sub-features

- `entry-first-run` an unpaired native app shows an **Add your computer** tile ("Desktop app · no terminal") first under "Not set up yet?".
- `entry-settings` Settings → Machines has **Add your computer** above **Pair another machine**.
- `link-and-qr` the screen shows the link's QR (dark on white in both themes), the link text, **Copy link** (with a "Link copied." line) and **Share link** (the system sheet).
- `pair-step` step 3 is **Scan the computer’s QR** (or **Enter its pairing code** where the device can't scan), into the existing consent and two-word check.
- `site-desktop` `/desktop` offers **Download for Linux** with version, size and sha256 only for a canonical `releases/download/<tag>/<name>.AppImage` asset. A foreign or invalid one is dropped. With no asset it says "not published yet", and an unreadable catalog says "could not check". Every case keeps the terminal install.
- `no-web` the entry is absent on web/PWA, because the desktop app offers only native codes, which a browser refuses (`assertSupportedOffer`). A build with no public base URL (the self-host web export) has no entry either.

## How to get to it (user POV)

- Fresh phone app: **Connect a machine** → scroll to **Not set up yet?** → **Add your computer**.
- Already paired: Settings → Machines → **Add your computer**.
- On the computer: open the link, download, open muxr, then on the phone **Scan the computer’s QR**.

## Driving it with the private stack

Preconditions:

- A release APK (`perf/buildPrApk.mjs`, store distribution, `https://trymuxr.com` base), a Play Store AVD booted with `-camera-back imagefile:<cam.png>`, and the emulator lock.
- The Linux AppImage from `yarn desktop:build:linux`, extracted with `--appimage-extract` (no libfuse2 here).
- The lab site from `apps/site/dist/site.js` with `PORT=<free>` and `MUXR_RELEASE_CATALOG_URL` pointing at a local catalog fixture whose stable `linux` entry names `https://github.com/umeranjum17/muxr/releases/download/v<version>/<file>.AppImage`, the local AppImage's sha256 and its byte size.
- An `fm-herdr-lab.sh` session for `HERDR_SOCKET_PATH`. Never use `~/.muxr`, `~/.config/herdr` or port 8792.

Steps:

- Launch the desktop app on Xvfb with `env -i`, a private HOME/XDG_RUNTIME_DIR/short TMPDIR/MUXR_HOME, `MUXR_RELAY_PORT=<free>`, `MUXR_RELAY_URL=ws://127.0.0.1:<port>`, `MUXR_DESKTOP_AUTOSTART=skip` and `--remote-debugging-port`. Then `adb -s <serial> reverse tcp:<port> tcp:<port>`.
- Read `#status-title` over CDP until "Ready to pair". Grab the window (`import -window root`), decode it with `zbarimg`, and composite the offer into `cam.png` (recipe in [pair-scan-first.md](./pair-scan-first.md)) before tapping Scan.
- Warm the Google code scanner once with a Scan and Back first; the first Scan on a fresh AVD only downloads the module.
- Timed journey: `pm clear`, tap the tile (t0), open the lab site's `/desktop` in a lab Chromium, check the sha256 the page shows against the file, start the app, scan, **Pair**, then click `#approve` over CDP when `#words` matches the phone. Stop when the phone's Home shows the computer as connected.
- Failure that recovers in place: at 270 dp font 2.0, remove the `adb reverse` before Scan. The pair page shows the retryable failure with **Try again**; restore the reverse and tap **Try again** to reach consent, then pair.
- Site: `npx vitest run test/site.journey.test.ts` from `apps/site` covers the offered, foreign-URL and unpublished `/desktop` cases.
- Pass: the tile and Settings row open the screen; the link QR decodes to the link; one scan reaches consent, the same two words show on both, and Home shows the computer connected.

## Gotchas

- The phone's link names the build's public base (`trymuxr.com/desktop`). The lab opens its own site instead, and the "download" is the local AppImage, matched by sha256, until a real release publishes a `linux` asset.
- No PWA leg: the desktop app mints native-only offers, and the web pair screen rejects those ("Native pairing codes are for phones"), so the entry is hidden on web. Add it to the PWA only once the desktop app can show a browser link.
- Run each lab from a frozen copy of the script. Editing a running bash script makes it read the new file at the old byte offset.
- `adb shell screenrecord` must be stopped on the device (`kill -2 $(pidof screenrecord)`) and awaited before the pull, or the mp4 has no moov atom.
