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

## Settled by reading the compositor's own source `[decided]`

**1. Capture is CPU-readable, with no GPU download step.** A compositor's screen
cast node chooses its buffer type from the client's format pod: xdg-desktop-
portal-hyprland hard-codes `SPA_DATA_MemFd` unless the client's `EnumFormat`
carries a `SPA_FORMAT_VIDEO_modifier` property, in which case it switches to
DMA-BUF (and logs `pw requested dmabuf`). This engine deliberately sends no
modifier and asks for MemFd, so frames arrive as mapped shared memory. It also
means the engine has no EGL, GBM or vendor-driver dependency at all — the whole
capture path is CPU, which is what makes it portable across machine classes. If
some other compositor ignores the request and produces DMA-BUFs anyway, the
engine drops those frames rather than reading garbage: a non-mappable buffer only
increments the dropped counter, and a source that never yields a readable buffer
gives up with the capture-start timeout, because capture never reports readiness.
The negotiated buffer type is visible through `desktop-host capture-probe`, which
is the only place it is reported.

**2. The Android side reuses the app's WebRTC binding.** The client package
compiles against the `org.webrtc` classes the installed `react-native-webrtc`
already ships, so one native library serves the whole app, and it builds its own
`PeerConnectionFactory` with `DefaultVideoDecoderFactory` (hardware-first, VP9
included). It never touches `WebRTCModule.options`, so the app's shared factory
and its voice path are unchanged. A second AAR copy was the alternative and was
rejected: two copies of the JNI library in one app is a worse failure mode than
one extra factory instance.

## The seam a consumer connects through `[decided]`

The engine needs exactly one thing from a consumer: somewhere for SDP and ICE to
travel. That is `Signaling` on the client side and `EngineClient.drainEvents` /
`acceptAnswer` / `addCandidate` on the host side, and it is deliberately small,
because every application already has an authenticated way to talk to itself.

muxr supplies its existing paired, encrypted request path and nothing else: no
address, port, code or certificate reaches the user, and the engine's session is
started by the host that already serves the terminal. A consumer with no channel
of its own is not left to invent one — `desklink-host bridge` re-serves the same
protocol over a WebSocket and serves a reference client that needs no build step,
so a stranger's first run is one command and one URL.

The same substitution is therefore available to both: the packages carry no muxr
concept, and muxr's contribution is one file that adapts its own channel to the
`Signaling` interface.

## Still open `[open]`

- Whether a persisted portal restore token makes the second visit to the desktop
  silent, or whether the compositor asks again. The engine returns the token the
  portal gives it (`session.restoreToken`) and accepts one on `session.open`; the
  behaviour is the compositor's to decide and is not claimed until observed.
- Whether a phone-sized encoded surface is the right default width for every
  source, or whether the consumer should pick per device. The engine takes a
  `maxWidth`/`maxHeight` box and never upscales; the default is 1280x800.
