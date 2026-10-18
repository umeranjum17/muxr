# Say plainly when the network has no path for the Computer picture

The Computer picture goes straight from the computer to the phone over WebRTC
when it can. When the relay is the only path (mobile data, no shared Wi-Fi, no
Tailscale, no Direct SSH), the native app carries the engine's loopback
ICE-TCP candidate over a `desktop.tcp` link stream and goes live anyway; the
browser cannot dial a JS socket, so the PWA never gets a frame. When an open
fails with a `never-connected` failure (no network path formed within the kit's
20 s first-frame bound), the Computer view says so in plain words, names what
works, and keeps Try again. Other failures keep their own copy: a `transport`
failure shows "Couldn't open this computer", and a lost phone ends with "The
phone lost its connection to this computer's desktop." Neither shows the
no-path message.

## Sub-features

- `relay-live` native, no UDP path: the picture goes live through the relay;
  Settings -> MACHINES -> machine -> Desktop decoder shows Frames decoded
  rising, and the host log reads "link: desktop picture carried over the link".
- `nopath` PWA first open, no UDP path: after the kit's 20 s first-frame
  bound (`never-connected`) the view reads "Can't show this computer's screen
  from here" with the generic body ("The screen goes straight from your
  computer to this phone, and this network has no way through. …") and Try
  again. No browser-specific body is shown.
- `retry` Try again starts a new open ("Starting desktop…").
- `large-text` at the largest text the overlay scrolls, so Try again is
  reachable (on main it was cut off).
- `after-frame` a transport loss after a frame keeps "Couldn't open this
  computer" (covered by `DesktopSurface.spec.tsx`; a lab cannot stage a
  frame and then cut UDP mid-session without a real desktop picture).

## How to get to it (user POV)

Pair with the lab computer, open the agent, Pane actions -> Computer, and
wait. Without a video path the Computer view stays on "Starting desktop…"
while the kit retries, then shows the message.

## Driving it with the private stack

Preconditions: `yarn build`; a private Xvfb for the host's desktop source
(`Xvfb :<d> -screen 0 1280x800x24 -nolisten tcp`). Start every lab host with
`MUXR_DESKTOP_SOURCE=x11 MUXR_DESKTOP_X11_DISPLAY=:<d>` and with `DISPLAY`,
`WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` unset, so the engine never touches
the owner's screen or portal. No Herdr is needed: the fake stack serves the pane.

Installed PWA (no UDP path):

1. Export with the lab flag (`lab-browser-pairing.md`) and start
   `browserPairLab.mjs` with the desktop env above; note its relay port.
2. Serve the export with `serveWebExport.mjs` on a free port `<web>`.
3. Outside the namespace: `node noVideoPathLab.mjs bridge unix2tcp <dir>/web <web>`,
   `… unix2tcp <dir>/relay <relay>`, `… tcp2unix <debug> <dir>/dbg`.
4. Inside: `DISPLAY=:<b> unshare -rn sh -c 'ip link set lo up; node noVideoPathLab.mjs bridge tcp2unix <web> <dir>/web & node … tcp2unix <relay> <dir>/relay & node … unix2tcp <dir>/dbg <debug> & exec chromium --no-sandbox --user-data-dir=<profile> --remote-debugging-port=<debug> --hide-scrollbars --app=http://127.0.0.1:<web>/'`.
   Record every PID; `--no-sandbox` because the namespace maps the user to root.
   Chromium on the host network is not a no-path lab: it reaches the engine's
   LAN candidates over UDP and goes live.
5. Pair with `__MUXR_LAB_PAIR__`, `emulate --viewport 270x594x2,mobile,touch`,
   then `node noVideoPathLab.mjs tap <debug> 'Open Pi 1, pi · Idle'`,
   `… tap <debug> 'Pane actions'`, `… tap <debug> Computer`. Poll
   `document.body.innerText` for `Try again` (about 30 s), then shoot each
   cell and run `visualCheck.mjs pwa-check`; at font 2.0 also scroll to the end.

Native Android (no UDP path; expect `relay-live`, not the message):

1. Hold the emulator lock; boot a task AVD with a `google_apis` image, then
   `adb -s <s> root` and, for `iptables` and `ip6tables`,
   `-I OUTPUT -p udp ! -o lo -j DROP` and `-I INPUT -p udp ! -i lo -j DROP`.
   Without this the emulator's NAT reaches the engine's LAN candidates and
   the picture goes live.
2. Start a fake stack with `transport: 'adb'` (`setAndroidSerial(<s>)` first)
   and the desktop env, so the relay arrives only through `adb reverse`.
3. Install the release APK, set `wm size 1080x2376; wm density 640`, mint a
   native offer (`mintPairing({ kind: 'native' })`) and open it with
   `am start -a android.intent.action.VIEW -d 'muxr://pair#<offer>'`.
4. Set `settings put system font_scale` first: changing it recreates the
   activity and drops the Computer view. Then open the agent -> Pane actions
   -> Computer and wait for the picture. Capture with `visualCheck.mjs` in
   light and dark (`cmd uimode night yes|no`). For the frame counter, enable
   developer mode (`desktop-decoder-probe.md`) and read Frames decoded.
   Before the link carrier, this lab showed the `nopath` message instead.

## Gotchas

- The Computer view over a terminal uses a dark scoped theme, so light and
  dark shots look the same on purpose; label the system mode.
- The message appears once the kit gives up: desklink 0.5.8 fails a first
  open whose path never formed as `never-connected` at 20 s, with no reopens
  (older kits reopened for about 4 minutes and ended in `transport`).
  "Starting desktop…" before that is expected.
- A theme or viewport change after the failure re-renders the same overlay
  without reopening, so one wait covers every cell.
