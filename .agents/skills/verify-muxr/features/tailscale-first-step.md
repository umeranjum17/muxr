# Get Tailscale before pairing your own computer

An unpaired app opens on one Tailscale card under the hero: "Start with
Tailscale", one line saying the free Tailscale app is needed on this phone (or
iPad/iPhone, or "device" in a browser) and on the computer, then "Sign in to the
same account on both.", a primary **Get Tailscale** and a secondary **I have Tailscale**.
The card's text and buttons must stay whole at 270 dp and font 2.0.
Get Tailscale opens Tailscale's store page: the Play Store app on Android (its
web page when the device has no Play Store), the App Store on iOS,
tailscale.com/download on the web/PWA. I have Tailscale shows the pairing
steps exactly as before (native: Step 1 command, Step 2 Scan, Other ways;
browser: the two step cards). There is no wizard and no second step.

## Sub-features

- `tailscale-card` the unpaired first screen shows only the Tailscale card under the hero; no pairing step is on screen until I have Tailscale.
- `get-tailscale` Get Tailscale opens `market://details?id=com.tailscale.ipn` in the Play Store (falls back to `https://play.google.com/store/apps/details?id=com.tailscale.ipn`), `https://apps.apple.com/app/id1470499037` on iOS, `https://tailscale.com/download` on the web; Back returns to the same card.
- `have-tailscale` I have Tailscale replaces the card with the unchanged pairing steps ([pair-scan-first.md](./pair-scan-first.md), [first-run-browser-steps.md](./first-run-browser-steps.md)).
- `launch-link-untouched` a pairing launch link or a pending hosted pairing still goes straight to the pair page; the card only gates the first screen.

## How to get to it (user POV)

Install the app fresh (or `pm clear com.trymuxr.app`) and open it: the card is
the first thing under "Run your agents from your phone." Tap Get Tailscale,
come back, tap I have Tailscale.

## Driving it with the private stack

Preconditions: no stack needed; the screen shows before any pairing. Release
APKs of main and the candidate from `perf/buildPrApk.mjs` (`JAVA_HOME` must
point at a real JDK: the mise `node` shim puts its own `keytool` shim first, so
pre-create `<out>/test.keystore` with the JDK's keytool). A task-owned
`google_apis_playstore` AVD so Get Tailscale reaches the Play Store app.

1. Under the emulator lock (`flock -w 3600 /tmp/fm-muxr-emulator.lock timeout 1800 …`),
   boot the AVD headless, install each APK fresh, and for 393 dp (`wm size
   1080x2376; wm density 440`) and 270 dp (density 640), `font_scale` 1.0 and
   2.0, `cmd uimode night no|yes`: force-stop, launch, screenshot, swipe up,
   screenshot again (the bottom of the card at 270 dp / 2.0 sits below the fold).
2. After I have Tailscale at 270 dp / 2.0 in both themes, capture the pairing steps.
3. Record at 393 dp / 1.0 light: first screen → Get Tailscale (Play Store shows
   Tailscale; `dumpsys activity activities` names `com.android.vending`) → Back
   → I have Tailscale → Step 1/Step 2.
4. PWA: serve `yarn web:export` with `serveWebExport.mjs` as in
   [first-run-browser-steps.md](./first-run-browser-steps.md) and capture the
   card at 393/270/208 px light and dark; Get Tailscale opens a new tab on
   `tailscale.com/download`; I have Tailscale shows the two browser step cards.
5. Pass: the card's text and both buttons are whole at every size and theme,
   the store opens on Tailscale, Back lands on the card, I have Tailscale shows
   the old pairing screen unchanged.

## Gotchas

- The card is React state, not a saved setting: relaunching the app unpaired
  shows it again. That is deliberate (a returning unpaired user sees one tap).
- The app does not detect an installed Tailscale: Android would need a native
  PackageManager call plus a `<queries>` entry for `com.tailscale.ipn`, and iOS
  has no Tailscale URL scheme to query.
- A Play Store emulator with no Google account may open the store on its
  sign-in page instead of the listing; `dumpsys activity activities` still shows
  `com.android.vending` resumed from muxr (it does not print the intent data).
- On a `google_apis` (no Play Store) AVD the fallback opens Chrome, which stops
  on its own first-run screen on a fresh image before showing the listing.
