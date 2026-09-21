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

**This version ships no prebuilt engine.** Installing the package does not give
you a working desktop on its own: the platform packages below are not published
yet, so the engine must be built from source (prerequisites in the next section)
and its path given to the package. Nothing here should be read as a one-step
install today.

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

### Build prerequisites

A source build links three system libraries through `pkg-config`, compiles
`native/vpx_shim.c` against libvpx's headers, and builds the vendored inputtino
project with CMake. On a clean machine, install:

| Need | Debian/Ubuntu | Fedora | Arch |
|---|---|---|---|
| Rust toolchain (`cargo`, `cc`) | `rustup` + `build-essential` | `rustup` + `gcc gcc-c++` | `rustup` + `base-devel` |
| CMake | `cmake` | `cmake` | `cmake` |
| `pkg-config` | `pkg-config` | `pkgconf-pkg-config` | `pkgconf` |
| libvpx (`vpx.pc`) | `libvpx-dev` | `libvpx-devel` | `libvpx` |
| PipeWire (`libpipewire-0.3`) | `libpipewire-0.3-dev` | `pipewire-devel` | `pipewire` |
| xkbcommon | `libxkbcommon-dev` | `libxkbcommon-devel` | `libxkbcommon` |
| Wayland (`wayland-client`) | `libwayland-dev` | `wayland-devel` | `wayland` |
| libevdev | `libevdev-dev` | `libevdev-devel` | `libevdev` |

Nothing is downloaded by the build itself. `cargo test` — including the engine
step in `yarn run check` — reports a loud skip that names the missing piece when
any of these is absent, instead of failing as though the engine's code broke.
Only a machine with all of them compiles and tests the crate.

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

## Connecting an application to it

The engine needs one thing from a consumer: somewhere for the SDP and ICE
candidates to go, and somewhere for the answer and the client's candidates to
come back. That is the whole seam, and it is deliberately the smallest possible
one, because every application already has a way to talk to itself.

```ts
import { EngineClient, resolveEngine } from '@desklink/host';

const engine = resolveEngine();                       // prebuilt, or a source build
const client = await EngineClient.start(engine.command, engine.args);
const session = await client.openSession({ permissions: ['view', 'control', 'clipboard'] });

// Everything the engine wants to tell the client arrives here, in order.
client.drainEvents().forEach((event) => myChannel.send(event));

// Bring the client's answer and candidates back.
await client.acceptAnswer(session.sessionId, session.generation, answerSdp);
await client.addCandidate(session.sessionId, session.generation, candidate, sdpMid, sdpMLineIndex);
```

`myChannel` is the application's own authenticated connection, whatever that is.
There is no second identity system, no pairing ceremony and no account: the
engine trusts the consumer's decision and enforces the scope it was given.

### If you have no channel of your own

`desklink-host bridge` re-serves the same protocol over a WebSocket, and serves a
reference client at `/` so the first run is one command:

```sh
desklink-host bridge --listen 127.0.0.1:19400
#  engine   /path/to/desklink-host
#  bridge   ws://127.0.0.1:19400/desktop
#  token    <generated>
#  open     http://127.0.0.1:19400/?token=<generated>
```

Open that URL and you have a desktop in a browser. `examples/reference-client.html`
is that page's source: one file, no build step, and the shortest complete
description of the protocol that exists.

Two things the bridge is honest about: `ws://` is plaintext, so keep it on a
private network or put it behind TLS; and the token in the URL *is* the
authorisation for that socket, so treat it as a credential.

## Packaging

The engine is a native executable, so the package ships a small JavaScript
launcher and depends on one platform package per supported target:

```text
@desklink/host
  optionalDependencies:              # added when those packages are published
    @desklink/host-linux-x64-gnu     # the executable, its notices and provenance
    @desklink/host-linux-arm64-gnu
```

They are deliberately **not declared yet**, because a declared optional
dependency that does not exist on the registry makes `yarn install
--frozen-lockfile` fail outright rather than being skipped — the whole install,
for every consumer, including ones that never open a desktop. Declaring them is
part of publishing them.

`resolveEngine` looks for the platform package first and falls back to a source
build, and it never searches `PATH`: a program that happens to be called
`desklink-host` is not evidence of which program is about to be given control of
a desktop.

The platform packages must be usable **without lifecycle scripts**, because
muxr's documented install uses `npm install --global --ignore-scripts`. Nothing
here downloads or chmods anything at install time; the executable arrives with
the executable bit already set in the tarball.

`platformTag()` includes the libc (`-gnu` or `-musl`) because a glibc binary on a
musl system fails in ways that read as "broken install" rather than "unsupported
platform". Only variants that have passed their own qualification are published:
`linux-x64-gnu` first, `linux-arm64-gnu` when a real machine has run a real
journey on it. macOS and Windows are separate backends, not separate builds.
