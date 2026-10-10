# Lead every pair entry with Scan

On the native app, every way into pairing leads with one Scan button that opens
the system QR scanner in one tap: first run, Home before the first pairing, the
recovery card's Pair again, Settings → Pair another machine, the command
palette, and a launch link. A code that has run out or was refused leads with
**Scan a new code**, plus one line saying to run `muxr pair` for a new one.
Pasting the string, and SSH, sit below as quieter options. A device that cannot
scan (web/PWA, an iOS simulator, an older iPad whose system scanner throws)
says so in one line and leads with paste; it never shows a Scan that cannot
open.

## Sub-features

- `scan-leads-entry` bare `/pair` (Home, recovery card, palette, PWA shortcut on native) and `/pair?source=settings` open with **Scan the QR** as the first, primary button; **Or paste the pairing string** and a secondary Connect sit below.
- `scan-new-code` an expired launch link, an expired QR scanned on first run or Home, and a code the computer refused all land on the pair page with the error and **Scan a new code** first, under it "On your computer, run muxr pair for a new code."
- `scan-retry` a retryable failure keeps **Try again** primary, then **Scan a new code**, **Enter another code**, and a quiet **Back**.
- `scan-one-tap` the Scan press opens the scanner directly; a camera permission still loading is asked for in the same tap, and a refusal offers **Open Settings**.
- `no-scanner` web/PWA, the iOS simulator, or a session whose scanner already failed to open lead with paste and say "This <device> can't scan a QR, so paste the pairing string from muxr pair." (first run: a "Paste the pairing string" tile).
- `ssh-untouched` `/pair?route=ssh` keeps its SSH form with no Scan.

## How to get to it (user POV)

- First run: open the app unpaired and tap **Step 2 · Scan the QR it shows**.
- Already paired: Settings → Pair another machine, the recovery card's Pair again, or the command palette's Connect Device.
- A code that ran out: open an old pairing link, or scan an old QR, and press **Scan a new code**.

## Driving it with the private stack

Preconditions:

- The private fake stack and pair socket from [pairing-consent.md](./pairing-consent.md) (relay on port 0, `--fake` host, fake Herdr; never `~/.muxr`). Mint each offer with `{"intent":{"kind":"native","authority":"control","personal":false}}` and answer `{"approval"}` with `{"yes":true}` to pair, or `{"yes":false}` to see the refused state. Render a QR from `offer.text` with `qrencode -o offer.png`.
- A release APK under a lab dev app id so it installs beside a phone's own `com.trymuxr.app` (perf/README recipe: `APP_ENV=development MUXR_APP_ID_BASE=<base> MUXR_DEV_APP_ID=<base>.dev MUXR_DISTRIBUTION=direct … -PmuxrDevelopmentApp=true`). That build answers `muxr-dev://` links.
- Emulator entries: open `/pair` bare from Home's **Enter pairing string**, Settings → Pair another machine, and an expired link with `adb -s <serial> shell am start -a android.intent.action.VIEW -d 'muxr-dev://pair#<old offer>' <app id>` (wait about two minutes after minting). Capture at 270dp (`wm size 1080x2376; wm density 640`) with `font_scale 1.3`, light and dark.
- Real scan: boot a Play Store AVD with `-camera-back imagefile:<cam.png>`, tap Scan, and confirm the consent card, the words, then Home. The emulator reads the file each time the camera opens, so re-mint and rewrite `cam.png` just before the tap. The preview crops the image's left part: `magick -size 900x900 xc:white \( offer.png -resize 300x300 \) -geometry +78+300 -composite cam.png` lands the QR in the viewfinder; a full-frame QR is too zoomed to read.
- PWA: `/pair` on the web export shows paste only and the browser line; there is no Scan.
- Pass: Scan is the first button on every native entry and error, one tap opens the scanner, a scanned code reaches consent and pairs, and a device that cannot scan never shows Scan.
- Repeatable check: `npx vitest run sources/pairing/application/pairArrival.integration.spec.ts -t 'leads every native pair entry'` (from `apps/mobile`).

## Gotchas

- expo-camera's `isModernBarcodeScannerAvailable` is true on any iOS 16+, including a simulator and pre-A12 hardware; only `launchScanner` finds out, by throwing. The app treats a simulator as no camera and remembers a failed launch for the session.
- Android's Google code scanner needs no camera permission; iOS asks on the first tap.
- A native offer expires in about two minutes; re-mint before each capture of a valid code. Pasting or linking a code that has not run out yet goes to consent, not the expired error: check `expires` in the decoded offer first.
- The first Scan on a fresh Android device fails while Play services downloads the scanner module (`ERR_BARCODE_SCANNING_FAILED`): one alert, Scan stays, the next tap opens it.
- The dev build's `muxr-dev://pair#…` link is not rewritten into a Pair route the way `muxr://` is, so a warm link from Home goes nowhere. Open the pair page and paste the string instead (Enter submits).
- Backing out of the Android scanner rejects with `ERR_BARCODE_SCANNING_CANCELLED`; that must leave the page alone (no alert, Scan still leads). On iPad the scanner is a popover, and tapping outside it closes it the same way.
- The lab's offers name only `ws://127.0.0.1:<relay>`, so a device off this machine (the Mac lab's iPad) reaches consent and then "Can't reach your computer": that is the `scan-retry` state, not a bug. Android reaches it through `adb reverse`.
- A camera lying face down sees black: the scanner opens but cannot read anything. Use the emulator's image camera or a device pointed at a screen for the real scan.
- On iPad, a "Pairing string" field already holding a code keeps it after **Enter another code**; typing appends. Open an expired code with a bundle-targeted launch link instead (`devicectl device process launch --payload-url … <QA bundle id>`), never a bare `muxr://` open.
