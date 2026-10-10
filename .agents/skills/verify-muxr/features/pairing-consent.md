# Read the pairing consent as short, plain bullets

Before a phone or browser is allowed to pair, the consent card says what this
device may do, how long it lasts, and the safety check, as two or three plain
bullets. It carries no raw backticks, no internal vocabulary ("machine keys",
"the access shown on the pairing screen"), and its icon is never clipped. A
control grant reads "can see and change things"; a browser view-only grant
reads "can see …, but can't change anything"; the browser line states the
eight-hour (or 30-day personal) lifetime, and the phone line states "until you
remove it". The last bullet always keeps "Only continue if you just ran muxr…"
so an unexpected card can never be waved through.

## Sub-features

- `consent-control` a phone or control-browser grant states see-and-change.
- `consent-view` a `--browser-view` grant states see-only, never see-and-change.
- `consent-duration` browser states the eight-hour/30-day life; phone states until removal.
- `consent-safety` the last bullet names the command the person just ran.
- `consent-plain` no backticks, no "machine keys", no "access shown on the pairing screen" anywhere in the pairing hints or errors.
- `consent-pairs-through` tapping Pair on the card actually pairs: a browser `https://…/pair#` link and a native code each reach the paired session list, never a refusal.

## How to get to it (user POV)

- Phone: run `muxr pair` (or scan the QR it prints) and read the card before tapping Pair.
- Browser: open a `muxr pair --browser` (or `--browser-view`) link and read the card.

## Driving it with the private stack

Preconditions:

- A private lab stack: `perf/lib/fakeStack.mjs` `startFakeStack({ transport: 'loopback', panes: 1, agents: 1, titleChurnHz: 0 })` (relay + `--fake` host + fake Herdr), all under a task-owned `TMPDIR`; never `~/.muxr`.
- Offers come from the host's owner-only socket `<stack.dataDir>/pair.sock`: send `{"intent":{"kind":"native"|"browser","authority":"control"|"observe","personal":false}}`, read `offer.text` from the reply, and answer any `{"approval"}` with `{"yes":true}`. Native codes expire in about two minutes; re-mint before each capture. One pending pairing per host.
- Phone: a release APK per build (`node perf/buildPrApk.mjs <out>`; throwaway test signer). Two builds signed with different test keys cannot `install -r` over each other: uninstall and pair again between before and after. Install on an owned x86_64 emulator and open the offer with `adb -s <serial> shell am start -a android.intent.action.VIEW -d 'muxr://pair#<offer>' com.trymuxr.app`. Set the reference widths with `wm size 1080x2340; wm density 480` (360dp) and `wm size 1080x2376; wm density 640` (270dp), `settings put system font_scale 1.3`, and `cmd uimode night yes|no`; relaunch after each change. At 270dp font 1.3 the card scrolls: capture the top and a scrolled frame that shows the Pair button.
- Browser/PWA: `yarn web:export`, serve `apps/mobile/dist` with `scripts/diagnostics/application/serveWebExport.mjs` on a free port, open `/pair`, and type `https://<any>/pair#byokit-link:…` (the raw `byokit-link:` token; a plain `http://127.0.0.1` URL is refused by a production export). Capture at 393 and 270 wide, dark and light.
- Both sides reach the paired state: after reading the card, tap Pair on the phone and press the paste/Connect route in the browser and confirm the paired session list appears. Reading the card is not enough — pairing itself must complete (see `consent-pairs-through`).
- Pass: every bullet is present and whole, the icon is uncut, the control/view wording matches the grant, no visible string contains a backtick or the banned phrases, and pairing completes for both a browser HTTPS link and a native code.

## Gotchas

- A native offer pasted into the web app is refused ("Native pairing codes are for phones"); the web app only accepts the `https://…/pair#` form, and a production export rejects an `http://127.0.0.1` loopback link as cut off.
- A browser link must pair, not just render the card. Since `fbd97175ea` (#719) the pair screen unwrapped the https offer and passed only the inner token, which the web guard refused with "Native pairing codes are for phones"; keep the HTTPS wrapper whole when handing the value to pairing (the phone still pairs on the inner offer). Prove `consent-pairs-through`, not the card alone, so this cannot regress unnoticed.
- `keytool` and `gradlew` need a real `JAVA_HOME`/`PATH`: a mise shim without a pinned java fails the release build. `perf/buildPrApk.mjs` generates its own test keystore only when `<out>/test.keystore` is absent.
- The card is centred in a scroll view; at 270dp font 1.3 the third bullet and the buttons fall below the fold, so a single top screenshot looks cut. Scroll to prove the whole card.
