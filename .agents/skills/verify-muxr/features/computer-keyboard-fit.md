# Keep a tapped desktop field above the keyboard in Computer

On an iPhone in landscape, tapping a field in the Computer preview and opening
the keyboard pans the desktop picture so that field stays visible above the
keyboard, and typed text shows in it. This must hold on a fresh app launch,
the normal first sign-in: with `@desklink/react-native` 0.5.3 the picture
snapped back to the desktop's top-left corner and hid a low field (the
password box) behind the keyboard. The pan lives in desklink's
`DesktopView.ios.tsx`; muxr only pins the version.

## Sub-features

- `kbfit-fresh` after `simctl terminate` + `simctl launch`, landscape -> Pane actions -> Computer -> tap the password field -> keyboard up: the focused field sits inside the picture band above the keyboard. Five independent fresh launches, all pass.
- `kbfit-type` on-screen keys typed right after show in that field.
- `kbfit-themes` light and dark.

## How to get to it (user POV)

- Open an agent's pane -> rotate the phone to landscape -> Pane actions -> Computer -> tap a field low on the desktop -> tap the keyboard button.

## Driving it with the private stack

Preconditions:

- The Mac iOS lab (`mac-ios` slot), a Release-iphonesimulator `muxr.app`
  built from the candidate, clean-installed on a simulator you booted, and an
  XCUITest driver that can rotate, tap points, tap keyboard keys and attach
  screenshots (axe HID taps do not reach the app).
- A private Linux stack per `../SKILL.md` Launch (`--fake` host), plus the
  host Computer on a private Xvfb: `MUXR_DESKTOP_SOURCE=x11
  MUXR_DESKTOP_X11_DISPLAY=:<n>`, relay bound to the tailnet address the Mac
  reaches. Headed Chromium on that display with
  `--force-device-scale-factor=1 --kiosk --window-size=1280,800`, started in a
  pane of your Herdr lab session, on a local sign-in page whose password field
  sits low (around desktop y 410-460 of 800).
- Pair through `$MUXR_HOME/host/pair.sock` (`{"intent":{"kind":"native",...}}`,
  answer `{"yes":true}`) and open `muxr://pair#<offer>` on the simulator;
  `cli pair` refuses a non-default `MUXR_HOME`.

1. Per run: restart Chromium on the page, `simctl terminate` + `simctl launch`.
2. Home -> Start an agent -> Shell -> Start (the fake host restores no panes,
   so a fresh launch lands on Home), rotate `landscapeLeft`, tap the pane
   actions button, then Computer. Shot `down`: the whole page.
3. In the same driver pass tap the password field, then the keyboard button.
   Shot `up`: the focused field is inside the picture above the keyboard.
4. Tap keys for a word; shot `typed`: the word is in the field.
5. Repeat for five fresh launches, alternating `simctl ui <udid> appearance`.

## Gotchas

- The field tap and the keyboard button must be one driver pass: the pan targets the last tap point.
- Rotate back to portrait at the end of each pass; a run left in landscape relaunches in landscape and the portrait tap points miss.
- On a loaded host the New agent sheet can show the offline fallback (no agents listed); that run is invalid, not a FAIL. Give the sheet longer and retry.
- Simulator screenshots are the portrait framebuffer with an orientation tag; `magick -auto-orient` before comparing.
- The keyboard key driver taps letters only; digits need the 123 layer.
