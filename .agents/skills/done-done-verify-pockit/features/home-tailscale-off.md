# Say Tailscale is off, not "no network", when only the computer is unreachable

When Home cannot reach the paired computer, the phone checks the internet on
its own before it blames anything (`reachVerdict()` in
`apps/mobile/sources/utils/web/deviceOffline.ts`: the relay's `/health`, then
two public endpoints, 3 s each). It picks one of three states:

- The relay answers: no device-side card.
- The internet answers but the relay does not, the relay is a Tailscale
  address (`*.ts.net` or 100.64.0.0/10) and Android reads no Tailscale address
  on this phone (`TailnetAddress.present()`): the recovery card reads
  "Tailscale is off on this phone", "This phone is online, but it reaches your
  computer through Tailscale. Turn Tailscale on, then tap Retry.", with
  **Open Tailscale** (opens the app; its store page when it is not installed)
  and Retry connection. While the link is still retrying, the busy card says
  the same, ending "muxr reconnects on its own".
- The internet answers but the relay does not, any other case (iOS and the
  web cannot read their own Tailscale state, LAN relays, the computer asleep):
  the existing "Computer unreachable" card with the restart command. Never
  "This device has no network".
- Neither answers: "You're offline" / "This device has no network. Check the
  connection, then tap Retry once you are back online." (unchanged).

## Sub-features

- `three-states` `reachVerdict` says `reachable`, `unreachable` or `offline`; the vitest flow `apps/mobile/sources/utils/web/deviceOffline.spec.ts` drives all three against real local servers.
- `tailscale-off-card` the Tailscale card and the Open Tailscale button, on Home's recovery card and its busy card.
- `open-tailscale` Android launches `com.tailscale.ipn` through `TailnetAddress.openApp()` (the module's manifest declares the package query); iOS and the web open the store page.

## How to get to it (user POV)

Pair the phone over Tailscale, then turn Tailscale off on the phone while it
stays on Wi-Fi or mobile data. Turn airplane mode on for the offline card.

## Driving it with the private stack

`node .agents/skills/done-done-verify-pockit/features/homeTailscaleOffLab.mjs <apk> <evidenceDir>`
(the `home-tailscale-off` journey), from the repo root after `yarn build`,
under the shared emulator lock, with `MUXR_LAB_AVD_HOME` a task-owned emulator
home and the APK a release build of the commit (`perf/buildPrApk.mjs`). It
runs the fake stack with the pairing offer naming this desktop's Tailscale
address (`tailscale ip -4`, read-only; never stop or reconfigure this
desktop's Tailscale), forwards that address to the loopback lab relay, pairs a
fresh install, closes only the forwarder (relay and host keep running), and
captures the Tailscale card at 390 dp font 1.0 and 270 dp font 1.3, light and
dark, under `native/`. It then taps Open Tailscale (expects muxr to leave the
foreground) and turns airplane mode on for the offline card at 390 dp dark.
Pass: `done; defects: 0` in `journey.log`, and every shot shows the whole card.

## Gotchas

- The emulator holds no Tailscale address but reaches this desktop's through
  the host's network stack, which is exactly a phone with Tailscale off whose
  path still worked a moment ago.
- Stopping the lab relay instead of the forwarder also works, but closing only
  the path shows the card does not depend on the host or relay going down.
