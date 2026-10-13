# Lead every pair entry with Scan

On the native app, every way into pairing leads with one Scan button that opens
the system QR scanner in one tap: first run, Home before the first pairing, the
recovery card's Pair again, Settings → Pair another machine, the command
palette, and a launch link. A code that has run out or was refused leads with
**Scan a new code**, plus one line saying to open muxr on the computer or run `muxr pair` for a new one.
Pasting the string, and SSH, sit below as quieter options. A device that cannot
scan (web/PWA, an iOS simulator, an older iPad whose system scanner throws)
says so in one line and leads with paste; it never shows a Scan that cannot
open.

## Sub-features

- `scan-leads-entry` bare `/pair` (Home, recovery card, palette) and `/pair?source=settings` open with **Scan the QR** as the first, primary button; **Or paste the pairing string** and a secondary Connect sit below.
- `scan-new-code` an expired launch link, an expired QR scanned on first run or Home, and a code the computer refused all land on the pair page with the error and **Scan a new code** first, under it "On your computer, open muxr or run muxr pair for a new code."
- `scan-retry` a retryable failure keeps **Try again** primary, then **Scan a new code**, **Enter another code**, and a quiet **Back**.
- `scan-one-tap` the Scan press opens the scanner directly; a camera permission still loading is asked for in the same tap, and a refusal offers **Open Settings**.
- `no-scanner` web/PWA, the iOS simulator, or a session whose scanner already failed to open lead with paste and say why — native "This <device> can't scan a QR, so paste the pairing string muxr shows on your computer.", web/PWA "Paste the pairing code from muxr on your computer." (no relay URL example) (native first run shows a "Paste the pairing string" tile instead of the scan step).
- `ssh-untouched` `/pair?route=ssh` keeps its SSH form with no Scan.
- `paste-connects` on the paste field, a complete code goes to consent by itself the moment it lands (paste or the last typed character), the keyboard's Go does the same, and Connect rides on top of the keyboard on Android and iOS (an anchored bottom bar in the PWA). A cut-off or wrong code never moves on by itself; Go or Connect shows the existing error ("This string is cut off. Copy all of it, or scan the QR."). A Connect tap while a pasted code is already being reviewed is ignored, so consent is never replaced by an error. SSH (`/pair?route=ssh`) still waits for Connect, because its fields come first.
- `paste-expired` a pasted code that has run out says so the moment it lands ("That pairing code has run out. Show a new one on your computer."), with no Connect press. After any failed code the one paste path is **Paste the new code** (primary where there is no Scan; native and PWA), which reviews whatever the clipboard holds; the field and Connect are hidden and come back, empty, only when that paste fails (no clipboard access, or no usable code on it: none, run out, or cut off), so a new paste is never joined onto the dead one (the old "cut off" after a second paste). The page scrolls the error into view once the keyboard closes. The computer side (`muxr pair` and the desktop window) shows a new code at the old one's half-life, so a copied code always has about a minute left; earlier codes stay good until their own expiry. Android shows its own "<app> pasted from your clipboard" toast over the bottom bar on any clipboard read; the app cannot place it, and it takes no taps.

## How to get to it (user POV)

- First run: open the app unpaired, tap **I have Tailscale** ([tailscale-first-step.md](./tailscale-first-step.md)), then **Step 2 · Scan the QR it shows**.
- Already paired: Settings → Pair another machine, the recovery card's Pair again, or the command palette's Connect Device.
- A code that ran out: open an old pairing link, or scan an old QR, and press **Scan a new code**.

## Driving it with the private stack

Preconditions:

- The private fake stack and pair socket from [pairing-consent.md](./pairing-consent.md) (relay on port 0, `--fake` host, fake Herdr; never `~/.muxr`). Mint each offer with `{"intent":{"kind":"native","authority":"control","personal":false}}` and answer `{"approval"}` with `{"yes":true}` to pair, or `{"yes":false}` to see the refused state. Render a QR from `offer.text` with `qrencode -o offer.png`.
- A release APK under a lab dev app id so it installs beside a phone's own `com.trymuxr.app` (perf/README recipe: `APP_ENV=development MUXR_APP_ID_BASE=<base> MUXR_DEV_APP_ID=<base>.dev MUXR_DISTRIBUTION=direct … -PmuxrDevelopmentApp=true`). That build answers `muxr-dev://` links.
- Emulator entries: open `/pair` bare from Home's **Enter pairing string**, Settings → Pair another machine, and an expired link with `adb -s <serial> shell am start -a android.intent.action.VIEW -d 'muxr-dev://pair#<old offer>' <app id>` (wait about two minutes after minting). Capture at 270dp (`wm size 1080x2376; wm density 640`) with `font_scale 1.3`, light and dark.
- Real scan: boot a Play Store AVD with `-camera-back imagefile:<cam.png>`, tap Scan, and confirm the consent card, the words, then Home. The emulator reads the file each time the camera opens, so re-mint and rewrite `cam.png` just before the tap. The preview crops the image's left part: `magick -size 900x900 xc:white \( offer.png -resize 300x300 \) -geometry +78+300 -composite cam.png` lands the QR in the viewfinder; a full-frame QR is too zoomed to read.
- PWA: `/pair` on the web export shows paste only, the "from muxr on your computer" line and Connect in the bottom bar; there is no Scan. Web first run's Step 2 opens this same screen.
- `paste-connects` on the emulator: boot with the soft keyboard on (`hw.keyboard=no` in the AVD `config.ini`), open the paste field and tap it, then capture with the keyboard up at 393dp (`wm size 1080x2424; wm density 440`) and 270dp (`wm size 1080x2376; wm density 640`): Connect must sit above the keyboard. Paste for real (the image has no `cmd clipboard`): on first run open Connect over SSH, tap the SSH host field by its placeholder, type the offer in 20-character `adb shell input text` chunks and check the uiautomator readback, then `input keycombination 113 29` (select all) and `input keyevent 277` (cut); open Paste the pairing string, focus its field and send `input keyevent 279` (PASTE). A 302-char offer stages in about 18 s, well inside a native offer's 2 minutes; the strict per-character helper (about 2.4 s a character) is too slow for that, and Settings search drops burst characters. At 270dp the SSH host field sits below the fold, so scroll before tapping it. Time paste → consent → Pair → Home with the lab host answering the approval. Before the fix the Android bar was a plain view behind the keyboard: a tap where Connect sat landed on the keyboard.
- `paste-expired`: paste a saved code more than two minutes old (same one-`input`-event paste on the PWA, clipboard + `keyevent 279` on the emulator). Pass: the run-out line shows at once and in view (check 270 dp at the largest font), the field is hidden, and **Paste the new code** with a fresh code on the clipboard reaches consent (the PWA can stub `navigator.clipboard.readText` to return it); with junk on the clipboard the field and Connect come back. Desktop/CLI: poll the window's `#expiry` text over CDP, or watch `muxr pair`'s printed code; a new one must appear at about 60 s left, never at 0.
- PWA `paste-connects`: set the field's value and dispatch one `input` event with a whole `https://<any>/pair#byokit-link:…` link (a clipboard paste is one event); consent ("… wants to pair with this browser") appears without a press. A link cut short plus `press Enter` shows the cut-off error and stays on the form.
- Pass: Scan is the first button on every native entry and error, one tap opens the scanner, a scanned code reaches consent and pairs, and a device that cannot scan never shows Scan.
- Repeatable check: `npx vitest run sources/pairing/application/pairArrival.integration.spec.ts -t 'leads every native pair entry'` (from `apps/mobile`); its last section is `paste-connects`.

## Gotchas

- expo-camera's `isModernBarcodeScannerAvailable` is true on any iOS 16+, including a simulator and pre-A12 hardware; only `launchScanner` finds out, by throwing. The app treats a simulator as no camera and remembers a failed launch for the session.
- Android's Google code scanner needs no camera permission; iOS asks on the first tap.
- A native offer expires in about two minutes, and the computer replaces the shown one after about one; re-mint (or recopy) before each capture of a valid code. Pasting or linking a code that has not run out yet goes to consent, not the expired error: check `expires` in the decoded offer first.
- The first Scan on a fresh Android device fails while Play services downloads the scanner module (`ERR_BARCODE_SCANNING_FAILED`): one alert, Scan stays, the next tap opens it.
- The dev build's `muxr-dev://pair#…` link is not rewritten into a Pair route the way `muxr://` is, so a warm link from Home goes nowhere. Open the pair page and paste the string instead (a whole code moves on by itself).
- Backing out of the Android scanner rejects with `ERR_BARCODE_SCANNING_CANCELLED`; that must leave the page alone (no alert, Scan still leads). On iPad the scanner is a popover, and tapping outside it closes it the same way.
- The lab's offers name only `ws://127.0.0.1:<relay>`, so a device off this machine (the Mac lab's iPad) reaches consent and then "Can't reach your computer": that is the `scan-retry` state, not a bug. Android reaches it through `adb reverse`.
- A camera lying face down sees black: the scanner opens but cannot read anything. Use the emulator's image camera or a device pointed at a screen for the real scan.
- On iPad, a "Pairing string" field already holding a code keeps it after **Enter another code**; typing appends. Open an expired code with a bundle-targeted launch link instead (`devicectl device process launch --payload-url … <QA bundle id>`), never a bare `muxr://` open.
- Under heavy host load, `wm size`/`wm density`/`cmd uimode night` switches leave a "System UI isn't responding" dialog over the app; tap **Wait** after each switch and launch before driving or shooting, or every capture shows the dialog.
- Entering a pairing string over adb: one `adb shell input text` is an unreliable injector — it dropped the last 20 characters of a 314-char offer in one trial here (the original pairing driver recorded 314 → 192), and re-sending appends instead of resyncing. Enter the field with the strict per-character helper `node scripts/diagnostics/application/checkFocusedSecretTyping.mjs --serial <s> --field 'Pairing string' --text <offer>` (one awaited `input text` per char, readback verified) or a real clipboard paste, never a single burst, and never a remembered tap coordinate — a stale coordinate lands on the Scan/QR card and opens the system scanner. In the runs recorded for this task a real clipboard paste delivered 109 of 109 characters and submit reached consent, so the reported 84-of-109 stall was the injector, not the field. Tracked as `pock-pair-entry-driver1`.
