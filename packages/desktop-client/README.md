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

<DesktopView sessionId={desktop.nativeId} style={{ flex: 1 }} />;
desktop.showKeyboard();
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

- **Hardware decoding.** The session builds its own peer connection with a
  hardware-first decoder factory, so a VP9 desktop decodes on the phone's video
  hardware rather than on the CPU, and no other WebRTC user in the app is
  affected.
- **Contained geometry.** Touch maps through the engine's reported surface
  rectangle. A touch outside the picture is not a desktop coordinate, and a
  letterboxed surface never sends a click to the wrong pixel.
- **One decision per gesture.** Tap, double-tap, drag and long-press are
  decided natively, with a slop threshold. A still hold is a right click where
  the finger rests, so every desktop app's context menu is one gesture away; a
  drag that leaves the surface is cancelled rather than released at a
  coordinate the user never pointed at.
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
