# @desklink/react-native

Show a live desktop in a React Native app, and drive it from the phone.

The package is a **view and a session**, not a screen: it renders the picture and
turns touch, the keyboard and the clipboard into that session's input. Where it
sits, how it starts, what the buttons look like and where "back" goes belong to
the application.

## Install

The package contains native code and is not an Expo Go package. It is not
published to npm yet: inside this repository it resolves through the workspace,
and the command below is what a consumer outside it will run once it is.

```sh
npx expo install @desklink/react-native      # or yarn add, then prebuild/rebuild
```

Android as a native module, plus the browser, which brings its own WebRTC.
`expo-module.config.json` declares the native side honestly rather than
compiling an untested stub for other platforms; `ios/DEFERRED.md` lists exactly
what an iOS backend has to implement.

It compiles against the WebRTC binding the app already ships
(`react-native-webrtc`) so there is one `org.webrtc` copy in the binary, and it
never touches that binding's process-global decoder factory.

## Use

```tsx
import { DesktopView, useDesktopSession, CONTROL_PERMISSIONS } from '@desklink/react-native';

const desktop = useDesktopSession({
    authorize: async () => ({
        signaling,                                   // your authenticated channel to the host
        session: { permissions: CONTROL_PERMISSIONS },
    }),
});

// Opening is a user action, so the app decides when it happens.
await desktop.connect();

<DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} keyboardClearance={96} />;
desktop.showKeyboard();
desktop.setOrientation('landscape');   // Android: hold the screen on its side; 'auto' to follow the phone
await desktop.pasteLocalToRemote(await Clipboard.getStringAsync());
```

A screen that only decides *whether* to offer a desktop does not need the
session: import the flag from its own entry, which is a constant on web and a
check for the platform module elsewhere, so the hook and the view stay out of
the first paint.

```tsx
import { desktopAvailable } from '@desklink/react-native/availability';

{desktopAvailable && <ComputerAction onPress={openDesktop} />}
```

### What the package guarantees

- **Hardware-first decoding.** The session builds its own peer connection with
  a hardware-first decoder factory for VP9, falling back to software on phones
  without a VP9 hardware decoder. No other WebRTC user in the app is affected.
- **A sharp, zoomable picture.** The desktop fits the view by default; a pinch
  zooms up to 2.5 view pixels per desktop pixel and one finger moves around the
  zoomed desktop. On Android the decoded frame is copied once into the view's
  own texture and drawn with a multi-tap filter when it is shown smaller than
  its size, so a fitted 4K desktop does not alias and a pinch redraws at once.
  `fitToView()` shows the whole desktop again.
- **A pointer a phone can see.** Once a touch has sent the desktop's pointer
  somewhere, the view draws it there at a readable size, over a picture whose
  own cursor is a few pixels tall or not captured at all. A mouse keeps its own.
- **The picture above the keyboard.** While the phone's keyboard is up, the
  picture sits above it and above the room the app keeps for its own controls
  (`keyboardClearance`), moving with the keyboard as it slides. A picture too
  tall for what is left keeps the pointer, where a tap just put the caret, in
  sight.
- **Contained geometry.** Touch maps through the picture's actual placement.
  A touch in the letterbox is not a desktop coordinate, and a drag that leaves
  the picture is held to its edge rather than released somewhere unseen.
- **The gestures remote-desktop viewers settled on,** decided natively with a
  slop threshold: tap to click, and a second tap close by is a double click on
  the same point; hold and release for a right click where the finger rested
  (every desktop app's context menu); hold then drag for the left button
  (select text, move a window); on the whole desktop a finger that moves
  carries the pointer with it, without a button, and the drawn pointer stays
  under the finger while the picture catches up; two fingers scroll the desktop
  under them, or pinch; a quick two-finger tap is a right click too. Scrolling
  is fractional wheel steps, smooth where the desktop supports high-resolution
  wheels. Every move is sent as the platform delivers it, once per frame.
- **The keys a phone lacks.** `modifiers`, `tapModifier` and `pressKey` give
  sticky Ctrl and Shift: tap arms one for the next key, tap again locks it.
  While one is armed, the next key or character the phone's keyboard types is
  sent as that key's chord, so Ctrl then v is Ctrl+V. The app draws the keys.
- **Readiness is a rendered frame.** `status: 'live'` is set by the first frame
  actually presented, not by a track arriving or ICE connecting.
- **Released state.** Unmount, background, session close and a lost control
  channel all release what the desktop was holding, so nothing is left pressed.
- **Explicit clipboard.** Two methods, called on a user action. The package
  never polls the clipboard and never uses it as a way to type.

### `Signaling`

The one thing the app must supply. It carries the engine's local protocol over
whatever authenticated channel the app already has:

```ts
interface Signaling {
    request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    subscribe(handler: (event: SessionEvent) => void): () => void;
}
```

`method` is one of `session.open`, `session.description`, `session.candidate`,
`session.close`; `SessionEvent` is the engine's offer, candidates, state and
revocation. Pixels and input do **not** use this channel — they are the
desktop's own WebRTC session.

## Licence

Apache-2.0. See `NOTICE`.
