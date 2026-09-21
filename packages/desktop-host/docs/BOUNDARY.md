# Boundary sketch — two packages, one consumer

Written before implementation as the contract the code has to satisfy. Status
markers are honest: `[decided]`, `[open]`.

## Why two packages and not one

The host side is a native, per-user, permission-bearing process: capture,
encode, WebRTC, kernel input. The client side is mobile-native: hardware decode,
a renderer, an IME bridge, the platform clipboard. They share exactly one thing —
a versioned wire contract — and nothing else. Putting them in one package would
mean the phone pins a native host build, or the host pins a mobile runtime.

## Package 1 — host engine `[decided]`

**Boundary:** "given a granted desktop source, produce a WebRTC video track and
apply authenticated input to the same desktop".

- In: `session.open`, SDP/ICE, scoped `session.input`, explicit clipboard
  read/write, close. See `docs/PROTOCOL.md`.
- Out: one VP9 video track, one offer, generation/geometry/state/metrics events.
- Process shape: per-user, on-demand, spawned by a consumer that already owns
  the session, spoken to over an inherited private channel. No listener, no
  daemon, no autostart, no root.
- Never: decides identity, installs rules, grants capabilities, carries audio,
  arbitrates two controllers, remembers a session across a restart.

The public surface carries no consumer concepts. A machine id, a chat, a pane or
an account never appears in the protocol or in the engine's state.

## Package 2 — React Native client `[decided]`

**Boundary:** "given an authorized session description, show the desktop and turn
local gestures into that session's input".

- `useDesktopSession({ authorize, signaling, onStateChange, onError })` owns
  connection, negotiation, readiness, reconnect and typed errors.
- `<DesktopView session style />` owns the live surface and gesture mapping. It
  owns nothing about layout, chrome, navigation or the conversation it sits in.
- `session.keyboard.show()/hide()`, `session.clipboard.readRemote()/writeRemote()`
  are the control primitives the app mounts wherever it wants.
- Native side owns: the video decoder factory selection (hardware VP9 rather
  than the underlying wrapper's software default), the renderer, the IME/text
  connection, platform clipboard, and the timely release of held remote input on
  background/unmount.
- The app supplies `authorize()` (a short-lived, engine-scoped capability) and
  `signaling` (an authenticated message adapter). The package never sees a
  pairing blob, a machine id or a token format, and never persists one.
- Platform files: `.native.ts` uses WebRTC through the app's existing native
  binding; `.web.ts` uses the browser's own `RTCPeerConnection`, so the same
  screen works in the PWA. `[open]` whether the browser shim can share the whole
  gesture/readiness layer or needs its own; that is decided by the first real
  PWA journey, not assumed.

## What the consumer (this application) keeps

- The computer action in the conversation and the return.
- Its own pairing, machine identity, authorization decision and revocation.
- Carrying SDP/ICE over its existing authenticated encrypted channel.
- Mapping an authorized request onto `session.open`'s permissions, and the
  product's own start/loading/error copy.
- Where the keyboard and clipboard controls sit, and the fact that internal ids
  are never displayed.

## Reused, not rebuilt `[decided]`

| Need | Already in this repository |
|---|---|
| Encrypted mobile → host request path, identity, grants | `packages/contract` control plane + `apps/host/src/requests` |
| Relay stream channel (host joins as machine, client as client) | `packages/contract` `wsTickets` / preview channel pattern |
| A reference for a "live surface inside a conversation" | `apps/mobile/sources/preview`, `apps/mobile/sources/takeover` |
| Flow-test style for the packages | `apps/mobile/sources/catalog/application/sessionSync.integration.spec.ts` |

## Reused, not rebuilt, outside the repository `[decided]`

| Need | Library | Licence |
|---|---|---|
| WebRTC peer, ICE, DTLS, SRTP, RTP | `webrtc` (webrtc-rs) | MIT / Apache-2.0 |
| Portal ScreenCast + PipeWire fd | `ashpd` (zbus) | MIT |
| PipeWire stream client | `pipewire` | MIT |
| VP9 encode | libvpx | BSD-3-Clause |
| Virtual mouse/keyboard | inputtino (uinput/libevdev) | MIT |
| Clipboard read/write | `wl-clipboard-rs` | MIT |
| Keyboard layout mapping | `xkbcommon` | MIT |

Not adopted: libwebrtc (a multi-gigabyte source build with an LGPL/GIO portal
seam), GStreamer (LGPL), and every GPL/AGPL remote-desktop application.

## Open questions the plan or the first real run has to settle

1. Whether the compositor's PipeWire node can be asked for CPU-mappable MemFd
   buffers, or whether every frame arrives as a DMA-BUF and needs an EGL
   download step. This is the single biggest cost uncertainty in the engine.
2. Whether the Android side reuses the app's installed WebRTC binding with an
   explicit decoder-factory configuration, or the package must own a native
   binding. Reuse is far cheaper; it needs one real device proof.
3. Where the portal's consent step sits in the product's start state, and
   whether a persisted restore token can make the second visit silent.
