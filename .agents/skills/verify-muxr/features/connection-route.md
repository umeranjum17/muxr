# Read the connection route on the phone

Settings > Connection shows the route the computer chose in `muxr setup`,
under `Current route`, with the same name and one-line description setup
showed on the computer (for example `Works only on this Wi-Fi` or
`Use muxr away from home (Tailscale)`).

## Sub-features

- `route-name` each `connectionMode` the host reports maps to the title
  `scripts/setup/presentation/setupWizard.mjs` gives that route; the route
  ids themselves never change.
- `route-detail` the line after the name is setup's own description for that
  route, in plain words.
- `route-unknown` a host that reports no mode falls back to a label inferred
  from the relay address, with a sentence saying so.
- `privacy-plain` the `Privacy` row says in plain words whether the
  connection itself is encrypted (`wss://`, `ws://` or SSH), never protocol
  names like WS or TLS.
- `relay-details` the raw relay address is hidden behind `Technical details`
  (`Show the relay address`); tapping the row shows `Relay address: <url>`.

## How to get to it (user POV)

- Home -> Settings (top right) -> Connection -> `Current route`.

## Driving it with the private stack

Preconditions:

- A dev-client APK on an owned emulator `SERIAL`, Metro for this checkout,
  and `adb -s $SERIAL reverse` for Metro, relay and host ports.
- A real relay and host (from `../SKILL.md` Launch, without `--fake` when a
  non-default Herdr lab session backs it) whose `selfhost.json` sets
  `connectionMode` to the route under test. `tailscale-direct` has the
  longest name, so use it for the narrow-screen case.
- A pairing offer from the host's `pair.sock` (`{"intent":{"kind":"native",
  "authority":"control","personal":false}}`, answer `{"yes":true}` to the
  approval event), delivered as `muxr-dev://pair#<offer>`.

- **Pair.** Open the deep link, scroll the consent sheet, tap `Pair`; Home
  shows the lab computer as `connected`.
- **Read the route.** Open Settings > Connection. `Current route` reads the
  setup title then ` · ` then setup's description.
- **Capture** with `adb -s $SERIAL exec-out screencap -p` plus a
  `uiautomator dump` of the same screen: light and dark at 270dp
  (`wm size 1080x2376`, `wm density 640`) font 1.0, and font 1.3. For a
  before/after pair, capture the base commit's wording first. The route line
  must wrap, never clip.
- **Privacy and details.** On the same screen, scroll to `Privacy` and
  `Technical details`; capture closed, then tap `Technical details` and
  capture again. A fake-stack lab (`perf/lib/fakeStack.mjs`, `mintPairing()`)
  with a release APK from `perf/buildPrApk.mjs` gives the `ws://` case.

## Gotchas

- Keep the `pair.sock` connection open until the phone has paired. Closing it
  once the offer arrives withdraws the offer, and the phone then says the
  code has run out even though it has not expired.
- Set the theme and font scale, then force-stop and relaunch. A live
  `uimode` change recreates the activity and can replay an earlier pairing
  link over the screen you were capturing.
- The app keeps a route screen it has already loaded. After you change the
  copy, relaunch the app and check the dumped text before capturing.
- Turn off the dev menu's Tools button first. Otherwise it covers the
  Settings button and a tap opens the dev menu.
