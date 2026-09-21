# @desklink/host

A per-user, on-demand desktop engine: capture the user's own screen, encode it,
carry it over WebRTC, and apply that session's pointer, keyboard and clipboard
actions back to the same desktop.

It is a **process with a documented local protocol**, not a service. A consumer
starts it, owns its stdin/stdout, carries the SDP/ICE over its own authenticated
channel, and stops it. Nothing in the engine's public surface refers to any
particular application.

## What it does

- **Capture** through the XDG Desktop Portal (`ScreenCast`) and PipeWire, so the
  compositor is the one that grants the desktop and the user is the one who
  consents. It asks for shared-memory buffers rather than DMA-BUFs, which keeps
  the pixel path on the CPU and out of the driver.
- **Encode** VP9 with libvpx in real time, single pass, no lookahead: one frame
  in, one packet out. Software by default, because a hardware encoder would put a
  vendor driver dependency on every machine class.
- **Transport** with WebRTC — ICE, DTLS, SRTP, RTP — and one data channel for the
  session's pointer/keyboard/clipboard.
- **Input** through [inputtino](https://github.com/games-on-whales/inputtino)
  (MIT) over `uinput`/`libevdev`: the engine creates its own virtual pointer and
  keyboard for the session and destroys them when it ends, releasing anything
  that was still held.
- **Clipboard** explicitly, in both directions, only when asked. It is never
  polled and never used as a hidden way to type.

## What it deliberately does not do

- It does not decide *who* the user is. The consumer authorizes; the engine
  enforces the scope it was given.
- It does not open a public listener, run as root, install udev rules, join
  groups or raise capabilities.
- It does not carry audio, arbitrate between two controllers, or remember a
  session across a restart.

## Install and run

The engine is a native binary. Building it from this package:

```sh
cargo build --release            # inside engine/
./bin/desklink-host.mjs path     # prints the binary this package will run
./bin/desklink-host.mjs capabilities
```

Point `MUXR_DESKLINK_ENGINE` at a binary built elsewhere if you have one. The
package never searches `PATH` for a same-named program: "a binary called
desklink-host" is not evidence of which program is about to be given control of
someone's desktop.

### Kernel input access

Creating virtual input devices needs write access to `/dev/uinput`. That is
whole-desktop control of the logged-in session, so it is a decision the user
makes, not something an installation does for them:

```sh
./bin/desklink-host.mjs setup-input
```

That prints the exact, narrowly scoped rule — and changes nothing. Without it the
engine still captures the desktop and reports the session as **view-only**, which
is a truthful degraded capability rather than a control surface that does
nothing.

## Talking to it

`docs/PROTOCOL.md` is the authority. In short:

```ts
import { EngineClient, resolveEngine } from '@desklink/host';

const engine = resolveEngine();
const client = await EngineClient.start(engine.command, engine.args);
const session = await client.openSession({ permissions: ['view', 'control', 'clipboard'] });
// carry `session.geometry` and the offer from `client.drainEvents()` to the
// client over your own authenticated channel, then:
await client.acceptAnswer(session.sessionId, session.generation, answerSdp);
```

## Licence and provenance

Apache-2.0. The engine links two permissive native libraries — libvpx
(BSD-3-Clause) and inputtino (MIT, vendored under `engine/vendor/`) — and calls
the portal over D-Bus rather than linking it. See `NOTICE`.

No GPL/AGPL remote-desktop code is copied, linked or derived; Sunshine,
Moonlight, Apollo and RustDesk were read as architecture references only.
