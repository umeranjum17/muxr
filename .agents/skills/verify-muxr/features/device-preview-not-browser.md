# See only device preview chips, never a Browser one

A pane's agent-device preview (an Android emulator, or an iOS Simulator the pane
claimed) shows a chip in the terminal header; the retired Browser preview never
appears. A stale `kind:'browser'` presence and a restored `desktop=preview` URL
both resolve to unavailable and never open Computer. Computer's own header reads
literally `Computer` from shell entry and from agent entry.

## Sub-features

- `preview-device-only` only `android` and `ios` previews show a chip, menu row
  and tooltip; there is no Browser chip, menu row or tooltip anywhere.
- `preview-stale-browser` a session whose presence still carries the retired
  `browser` kind shows no chip and opens nothing; the phone never manufactures a
  Browser target, and a `desktop=preview` URL with no resolvable target stays
  unavailable rather than opening Computer.
- `preview-computer-title` Computer's header is `Computer` for a shell pane and
  for an agent pane, while the conversation's own naming elsewhere is unchanged.
- `preview-device-kept` Android/IOS device previews, their leases and authority
  checks still work (see ./ios-simulator-preview.md).

## How to get to it (user POV)

Pair a phone to the lab host. Open a shell pane and Pane actions > Computer: the
header reads `Computer`. Open an agent pane and its Computer: the header also
reads `Computer`, with the agent shown underneath/on return. A pane whose agent
shows a device preview shows its Emulator/Simulator chip and opens it; a pane
that only had the retired Browser preview shows no chip.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation and the native-journey rules in
../features/computer-failure.md. Use a guarded, non-default Herdr lab instead of
the fake host; start the real relay and host in lab shell panes with a private
`MUXR_HOME` and `HERDR_SOCKET_PATH`. Build a release candidate (Android APK for
the emulator's ABI; iOS simulator build) and record its source and hash.

1. Acquire the assigned emulator lock; use a task-owned AVD and an explicit
   `adb -s "$SERIAL"` on every call. Deliver a fresh lab pairing offer and
   approve it inside the lab terminal; do not inject an owner token.
2. Have a lab agent start a headless Android emulator attributed to its pane
   (and, on macOS, `muxr preview claim <udid>` for a simulator you created).
   Open that pane: capture the chip row with the device chip present.
3. Open Computer from a shelved shell pane and from the agent pane; capture the
   header from both entries. It must read `Computer`; conversation naming
   elsewhere is untouched.
4. Stale Browser: stand the phone on a host that announces the retired
   `browser` kind (an older host, or a stored presence from an upgraded install).
   Capture that the pane shows no chip and Computer opens nothing on its behalf.
   Also restore a `desktop=preview` route with no resolvable device target and
   capture the same unavailable result — never the Computer desktop.
5. Capture dark and light themes for each state. Keep one motion recording of a
   device chip opening the preview and of Computer opening from agent entry.
6. Save screenshots, recordings, APK identity and command results outside the
   repo. Stop only exact owned processes, tear down through the guarded helper,
   and verify the default-session tripwire. Delete task scratch, not evidence.

## Gotchas

- The host no longer produces a `browser` presence, so the stale state must come
  from an older host or a stored record — never fabricate host code to emit it.
- A `desktop=preview` URL resolving to no target must show no Computer; the real
  desktop is a separate, deliberate Computer tap, and the real-desktop acceptance
  run is out of scope for this slice.
- A blank capture or a development client cannot prove the release UI. Report
  missing proof explicitly; never share pairing offers, grants or private logs.
