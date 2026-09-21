# Own-display proof: the desktop engine end to end on a display this task owns

Run on 2026-09-21/22 against **Xvfb `:99`** with a purpose-written X client
(`packages/desktop-host/engine/examples/x11_target.rs`) as the thing being driven.
No part of this touched the captain's session: his desktop was neither captured
nor injected into.

This is **not** live-desktop proof. The portal consent path and `uinput` input are
exercised only against his own machine, which is the one outstanding gate.

## What was driven

```text
desklink-host bridge --listen 127.0.0.1:19400 --source x11 --display :99
  -> engine: portal-free X11 root capture + XTest input
  -> browser: packages/desktop-host/examples/reference-client.html
```

The reference client is a plain page with no build step. It is simultaneously
the third-party consumer path (a WebSocket carrying the engine's own protocol)
and the browser receiver.

## Observations

**Capture and decode.** The browser's `inbound-rtp` video report after a few
seconds: `framesDecoded 233`, `framesReceived 345`, `frameWidth 1280`,
`frameHeight 720`, `video.videoWidth 1280`. Reading the rendered `<video>` back
through a canvas returned the target's own four bands — red `(220,78,65)`,
green `(54,186,65)`, blue `(62,72,206)`, yellow `(210,201,66)` against the
source colours `(208,64,64)`, `(64,208,64)`, `(64,64,208)`, `(208,208,64)`.

**Pointer.** A tap at the browser's expected surface point `(319,540)` produced,
in the target's own event log:

```json
{"kind":"pointer","x":319,"y":540}
{"kind":"button","x":319,"y":540,"button":1,"phase":"down"}
{"kind":"pointer","x":319,"y":540}
{"kind":"button","x":319,"y":540,"button":1,"phase":"up"}
```

A drag produced `down` at the start point, `move` along the way and `up` at the
end; a wheel event produced `button 5` down/up pairs.

**Keyboard.** Committed text and named keys arrive as real key codes:
`{"kind":"key","keycode":38,...}` for `a` (evdev 30 + the X server's 8 offset)
and `{"kind":"key","keycode":36,...}` for Enter (evdev 28 + 8), each down and up.

**Close releases what is held.** With left Control down and pointer button 1
down and dragging, `session.close` produced, in the target's log:

```json
{"kind":"button","x":681,"y":360,"button":1,"phase":"up"}
{"kind":"key","keycode":37,"phase":"up"}
```

Buttons before keys, and only what this session had pressed.

**Reopen.** Opening again after the close gave a live session again
(`framesDecoded 68` and rising, `1280x720`, no stale frame).

**Failure and reconnect.** Killing the bridge produced a visible failure state —
`Disconnected`, the video cleared to `0x0`, the Reconnect control enabled.
Restarting the bridge and pressing Reconnect returned a live desktop
(`framesDecoded 150`, `1280x720`).

## Bugs this run found, and fixed

1. **No WebRTC runtime was enabled** in the engine's build: the `webrtc`
   dependency had lost its `runtime-tokio` feature, so *every* session failed at
   `PeerConnection`. It is now enabled and the failure is impossible to miss.
2. **The peer had no UDP socket to gather from** (`no udp_sockets or
   tcp_listeners available`): the builder was never given a listen address.
3. **The decoder produced zero frames.** The browser received 269 frames and
   decoded none: the encoder's only key frame was the first one, sent before the
   far end was receiving. The peer now asks for a reference frame when the
   transport connects and when the control channel opens, and the encoder emits
   a recovery key frame at least every four seconds.
4. **Control replies never reached the client.** The engine created the control
   channel — because it is the offerer — but only listened for a channel the
   *remote* opened, so it accepted input on one stream and sent `hello`, acks and
   clipboard answers on another that nobody read. The engine now serves the
   channel it created.
5. **A clipboard read could hang the session.** The clipboard backends block and
   were called inline on the async runtime. They now run on a blocking thread
   behind a three-second bound, so a desktop with no clipboard service answers
   with a readable error.
6. **The client's letterbox maths crashed the app.** The native view positioned
   its renderer with `FrameLayout.LayoutParams`, which is not what the parent
   lays out with. The renderer now fills the view, letterboxes itself, and the
   touch mapping computes the same rectangle arithmetically.

## The same journey in the real PWA

The muxr web build (`expo start --web`) against the same lab host, using the
browser implementation of the desktop client package (`src/native.web.ts`):

- `Pane actions -> Computer` navigated to the desktop route and the surface went
  live: a `<video>` element at `1280x720`, laid out at 948x533 inside the route.
- A tap at the expected surface point `(960,180)` produced, in the target's log:

```json
{"kind":"pointer","x":960,"y":180}
{"kind":"button","x":960,"y":180,"button":1,"phase":"down"}
{"kind":"pointer","x":960,"y":180}
{"kind":"button","x":960,"y":180,"button":1,"phase":"up"}
```

Three defects were found and fixed getting there: the desktop route had no entry
in the stack layout and collapsed to zero size inside the web route, the web
module did not export the availability flag the view checks, and a protocol
helper was reached through the wrong module.

## Not covered here

- **Portal consent and `uinput` input**: both need the captain's own session.
- **Clipboard transfer**: the engine's clipboard uses the compositor's clipboard
  protocol, which an X display has none of. On `:99` the request is answered in
  1ms with `Could not find wayland compositor`, which is the honest degraded
  answer, not a transfer. The transfer itself is proved in the morning window.
