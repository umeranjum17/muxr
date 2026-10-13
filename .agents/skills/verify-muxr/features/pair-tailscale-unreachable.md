# Say which end to fix when pairing can't reach the computer over Tailscale

When the phone's first dial of the computer's Tailscale address (a `*.ts.net`
name or a 100.64.0.0/10 address in the pairing code) gets no answer, the pair
screen says in one sentence what to fix, instead of the kit's generic "Can't
reach your computer. Check it's on and connected." or "Your computer didn't
answer in time." It keeps **Try again** on
the same code, since nothing was claimed.

- Android, no Tailscale address on this phone (Tailscale off or signed out
  here): "Can't reach `<computer>`: turn on Tailscale on this phone and sign
  in, then try again."
- Android, this phone holds a Tailscale address (the computer is asleep,
  offline, has Tailscale off, or is on another account): "Can't reach
  `<computer>`: check it's awake and Tailscale is on there, signed in to the
  same account as this phone."
- iOS and the web/PWA, where the app cannot read its own Tailscale state:
  "Can't reach `<computer>`. Is it awake and is Tailscale connected on this
  `<iPhone|iPad|device>` and the computer?"

A LAN or other address, an SSH-tunnelled pairing, and every failure after the
two words keep their existing wording.

## Sub-features

- `tailscale-first-dial` a Tailscale-address offer whose first dial fails (unreachable or timeout) shows one of the three sentences above, with Try again, Scan a new code, Enter another code and Back.
- `phone-tailscale-signal` Android reads `TailnetAddress.present()` (`apps/mobile/modules/tailnet-address`): an up `tun*` interface with an IPv4 in 100.64.0.0/10. A carrier CGNAT address on mobile data does not count.
- `good-case-untouched` an offer for this desktop's real Tailscale address pairs exactly as before; the signal is read only after a failed dial, never to skip one.

## How to get to it (user POV)

On the computer run `muxr pair` while the computer is asleep or off the
tailnet (or with Tailscale off on the phone), scan the QR on the phone, tap
Pair, and read the sentence under the consent card.

## Driving it with the private stack

Preconditions: follow `../SKILL.md` isolation (private `MUXR_HOME`, relay on
`MUXR_RELAY_PORT=0`, never 8792, never `~/.muxr`), a guarded non-default
Herdr lab session for the host (`fm-herdr-lab.sh`), release APKs of main and
the candidate from `perf/buildPrApk.mjs`, and a task-owned `google_apis`
x86_64 AVD (rootable, for the Tailscale-on variant). Never stop, reconfigure
or sign out this desktop's Tailscale; `tailscale ip -4` is read-only.

1. Start the relay with `MUXR_RELAY_HOST=0.0.0.0` and the real host (no
   `--fake`, `HERDR_SOCKET_PATH` = the lab socket) with a `selfhost.json`
   whose `relayUrl` is the address to advertise. Bad case: an unused tailnet
   address, `ws://100.64.0.99:<relay port>`. Good case: this desktop's own
   `ws://<tailscale ip -4>:<relay port>`. Restart the host after each change;
   it reads the advertised address at start.
2. Mint each native offer on `<MUXR_HOME>/host/pair.sock`
   (`{"intent":{"kind":"native","authority":"control","personal":false}}`,
   answer `{"approval"}` with `{"yes":true}`), open it with
   `adb -s <serial> shell "am start -a android.intent.action.VIEW -d 'muxr://pair#<offer>' com.trymuxr.app"`,
   and tap **Pair** on the consent card.
3. Bad case on each build (main, candidate) at 393 dp (`wm size 1080x2424; wm
   density 440`) and 270 dp (`wm size 1080x2376; wm density 640`) light, plus
   270 dp dark at `font_scale 1.3`: wait for "Try again" (about 8 s, the
   kit's dial timeout) and capture. Main shows "Your computer didn't answer in
   time."; the candidate on a plain emulator shows the "turn on Tailscale on
   this phone" sentence, because the emulator holds no Tailscale address.
4. Tailscale-on variant: `adb root`, then
   `ip link add tun8 type dummy && ip addr add 100.101.7.7/32 dev tun8 && ip link set tun8 up`
   (`ip addr show tun8` must say `LOWER_UP`); the same bad offer now names the
   computer end. Delete `tun8` after.
5. Good case: advertise this desktop's Tailscale address and pair; the words
   step, the check mark and Home follow as before.
6. PWA: `yarn web:export` per build, serve with `serveWebExport.mjs`, open
   the `--app=` window, open `/pair`, paste a browser offer
   (`KIND=browser` mint, wrapped as `https://<any>/pair#byokit-link:…`) whose
   URLs name the unused tailnet address, press Pair, and capture at 393 and
   270 px light and dark: the candidate shows the "on this device and the
   computer" sentence; main shows "Your computer didn't answer in time.".
7. Pass: each sentence is whole at every size and theme, Try again stays on
   the code, the good case pairs, and main shows its old timeout sentence.
- Repeatable check: `npx vitest run tests/cross-side/linkPairing.integration.test.ts -t 'which end to fix'` (repo root, after `yarn build`).

## Gotchas

- An unused 100.x address hangs until the kit's 8 s dial timeout; a `*.ts.net`
  name that does not exist fails in well under a second (NXDOMAIN). The flow
  test uses the name to stay fast.
- The emulator reaches this desktop's tailnet address through the host's
  network stack, without a Tailscale address of its own, which is why the
  signal is read only after a failed dial: reading it first would refuse a
  pairing that works.
- A bare `ip tuntap` interface has no process behind it, so it reports
  `NO-CARRIER` and Android's `NetworkInterface.isUp()` calls it down: the
  Tailscale-on variant then shows the Tailscale-off sentence. Stage a dummy
  link named `tun*` instead; a live Tailscale tun is up and running.
- At 270 dp and `font_scale 1.3` the consent card's Pair button and the
  failure actions sit below the fold; swipe up before tapping, and capture a
  scrolled shot to show every action is reachable.
- On the PWA a pasted browser offer goes straight to the consent card; the
  button to press is Pair, not Connect.
