# @desklink/host

A per-user, on-demand desktop engine: capture the user's own screen, encode it,
carry it over WebRTC, and apply that session's pointer, keyboard and clipboard
actions back to the same desktop.

It is a **process with a documented local protocol**, not a service. A consumer
starts it, owns its stdin/stdout, carries the SDP/ICE over its own authenticated
channel, and stops it. Nothing in the engine's public surface refers to any
particular application.

## What it does

- **Capture** through the XDG Desktop Portal (`ScreenCast`) and PipeWire, with
  compositor consent, or from an explicitly selected X display's root window.
  The portal path asks for shared-memory buffers rather than DMA-BUFs, keeping
  its pixel path on the CPU and out of the driver.
- **Encode** VP9 with libvpx in real time, single pass, no lookahead: one frame
  in, one packet out. Software by default, because a hardware encoder would put a
  vendor driver dependency on every machine class. Tuned for a desktop: the
  desktop's own pixels up to 4K (a phone zooms in, and text has to survive it),
  screen-content mode, key frames only on request, and a refinement pass that
  re-codes a still desktop once at a fine quantizer so it reads sharp.
- **Transport** with WebRTC — ICE, DTLS, SRTP, RTP — and one data channel for the
  session's pointer/keyboard/clipboard.
- **Input** through [inputtino](https://github.com/games-on-whales/inputtino)
  (MIT) over `uinput`/`libevdev` for portal capture, or XTest for an X display.
  Both release held input when the session ends.
- **Clipboard** explicitly, in both directions, only when asked. It is never
  polled and never used as a hidden way to type. On Wayland, writes require
  `wl-copy` from `wl-clipboard`; its selection server keeps the copied text
  available after the desktop session ends, until another app replaces it.

## What it deliberately does not do

- It does not decide *who* the user is. The consumer authorizes; the engine
  enforces the scope it was given.
- It does not open a public listener, run as root, install udev rules, join
  groups or raise capabilities.
- It does not carry audio, arbitrate between two controllers, or remember a
  session across a restart.

## Install and run

```sh
npm install @desklink/host
npx desklink-host path            # the engine this install will run
npx desklink-host capabilities    # what this machine can do right now
```

On **Linux x64 with glibc 2.36 or newer** — Debian 12, Ubuntu 24.04, Fedora 37
or later, Arch — that is the whole install. npm also installs the optional
platform package `@desklink/host-linux-x64-gnu`, which carries the prebuilt
engine, and `resolveEngine()` finds it there. No Rust toolchain, compiler or
install script is involved, so `--ignore-scripts` installs work. The engine
requires the system's `libpipewire-0.3.so.0`, `libxkbcommon.so.0`,
`libevdev.so.2` and `libstdc++.so.6` (normally supplied by a modern Linux
desktop). If one is missing, the host reports `missing system library: <name>`
with code `missing-system-library` rather than failing silently; it does not
bundle these system libraries. libvpx and inputtino are linked into the engine.

The one step no install does for you is [kernel input access](#kernel-input-access),
and only the portal backend needs it.

There is no prebuilt engine for any other platform. Another Linux (arm64, musl)
can [build it from source](#building-from-source). macOS and Windows are not
supported: `capabilities` there says the engine runs on Linux only.

Point `MUXR_DESKLINK_ENGINE` at a binary built elsewhere if you have one. The
package never searches `PATH` for a same-named program: "a binary called
desklink-host" is not evidence of which program is about to be given control of
someone's desktop.

### Building from source

```sh
cd packages/desktop-host        # from the repository root
cargo build --release --manifest-path engine/Cargo.toml
./bin/desklink-host.mjs path     # prints the binary this package will run
./bin/desklink-host.mjs capabilities
```

A source build links system libraries through `pkg-config`, compiles
`native/vpx_shim.c` against libvpx's headers, and builds the vendored inputtino
project with CMake. On a clean machine, install:

| Need | Debian/Ubuntu | Fedora | Arch |
|---|---|---|---|
| Rust toolchain (`cargo`, `cc`) | `rustup` + `build-essential` | `rustup` + `gcc gcc-c++` | `rustup` + `base-devel` |
| CMake | `cmake` | `cmake` | `cmake` |
| `pkg-config` | `pkg-config` | `pkgconf-pkg-config` | `pkgconf` |
| libvpx (`vpx.pc`) | `libvpx-dev` | `libvpx-devel` | `libvpx` |
| PipeWire 0.3.65+ (`libpipewire-0.3`) | `libpipewire-0.3-dev` | `pipewire-devel` | `pipewire` |
| xkbcommon | `libxkbcommon-dev` | `libxkbcommon-devel` | `libxkbcommon` |
| Wayland (`wayland-client`) | `libwayland-dev` | `wayland-devel` | `wayland` |
| libevdev | `libevdev-dev` | `libevdev-devel` | `libevdev` |
| libxcb (source/container builds only) | `libxcb1-dev` | `libxcb-devel` | `libxcb` |

These are build prerequisites, not additional runtime requirements for the
prebuilt package; in particular, libxcb is not a prebuilt runtime requirement.
Nothing is downloaded by the build itself. The engine step in `yarn run check`
skips with a list of missing prerequisites when any of these is absent; direct
`cargo test --manifest-path engine/Cargo.toml` does not skip and needs them
installed. Only a machine with all of them compiles and tests the crate.

### Kernel input access

Ordinary tests do not create real desktop devices. To opt into the hardware
probe explicitly, run `DESKLINK_TEST_UINPUT=1 cargo test this_host_can_create_and_destroy_the_virtual_devices`
inside `engine/` on a desktop you are authorized to control.

Creating virtual input devices needs write access to `/dev/uinput`. That is
whole-desktop control of the logged-in session, so it is a decision the user
makes, not something an installation does for them:

```sh
npx desklink-host setup-input                     # where @desklink/host is installed
npx -p @desklink/host desklink-host setup-input   # anywhere else, e.g. under an application that depends on it
```

That prints the exact, narrowly scoped rule — and changes nothing. Without
`uinput` access a portal session can still be opened with `view` permission;
asking for `control` is refused rather than presenting inert controls. An X
session instead uses XTest and does not need `/dev/uinput`.

## Licence and provenance

Apache-2.0. The engine links two permissive native libraries — libvpx
(BSD-3-Clause) and inputtino (MIT, vendored under `engine/vendor/`) — and calls
the portal over D-Bus rather than linking it. See `NOTICE`. The prebuilt engine
links libvpx statically and carries every licence text it owes, including each
linked crate's, in its package's `THIRD_PARTY_LICENSES.txt`, with the Rust
standard library's own notices in `COPYRIGHT-rust-library.html`. Its build
refuses any crate whose licence is not permissive.

No GPL/AGPL remote-desktop code is copied, linked or derived; Sunshine,
Moonlight, Apollo and RustDesk were read as architecture references only.

## Connecting an application to it

The engine needs one thing from a consumer: somewhere for the SDP and ICE
candidates to go, and somewhere for the answer and the client's candidates to
come back. See `docs/PROTOCOL.md` for the authoritative wire contract.

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

`desklink-host bridge` is the minimal runnable example for third-party consumers:
it re-serves the same protocol over a WebSocket and serves a reference client
at `/` so the first run is one command:

```sh
desklink-host bridge --listen 127.0.0.1:19400
#  engine   /path/to/desklink-host
#  bridge   ws://127.0.0.1:19400/desktop
#  token    <generated>
#  open     http://127.0.0.1:19400/?token=<generated>
```

Open that URL and you have a desktop in a browser. `examples/reference-client.html`
is that page's source: one file, no build step, and the shortest complete
description of the protocol that exists. The bridge operator chooses the capture
source with its flag or environment; clients cannot choose or override it.

Two things the bridge is honest about: `ws://` is plaintext, so keep it on a
private network or put it behind TLS; and the token in the URL *is* the
authorisation for that socket, so treat it as a credential.

## Packaging

The engine is a native executable, so the package ships a small JavaScript
launcher and depends on one platform package per supported target, which npm
installs only where its `os`, `cpu` and `libc` match:

```text
@desklink/host
  optionalDependencies:
    @desklink/host-linux-x64-gnu     # the executable, THIRD_PARTY_LICENSES.txt, provenance.json
```

The optional dependency is written into the published manifest by
`release/pack.mjs`, pinned to the same version, and is deliberately absent from
the source `package.json`: an optional dependency the registry does not have
yet makes a workspace's `yarn install --frozen-lockfile` fail outright rather
than skip it.

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
`linux-x64-gnu` now, `linux-arm64-gnu` when a real machine has run a real
journey on it. macOS and Windows are separate backends, not separate builds.

### Building and packing a release

Needs Docker and Node, nothing else: no Rust toolchain or system libraries.

```sh
packages/desktop-host/release/build-engine.sh     # -> dist-desklink/engine-linux-x64-gnu/
npx tsc --build packages/desktop-host
node packages/desktop-host/release/pack.mjs --engine dist-desklink/engine-linux-x64-gnu
packages/desktop-host/release/check-install.sh    # fresh install in a clean container
```

`build-engine.sh` builds the engine from this checkout in the container that
`release/linux-x64-gnu.Dockerfile` pins: base images by digest, Debian packages
by snapshot date, the Rust toolchain by version, libvpx by commit, crates by
`Cargo.lock`. The same source gives the same executable, byte for byte. The
build fails if libvpx ends up dynamically linked, if the executable needs a
glibc newer than 2.36, or if any crate's licence is not permissive
(`release/notices.mjs`, which also writes `THIRD_PARTY_LICENSES.txt`).
`provenance.json` records the source commit, the pinned inputs and the
executable's SHA-256.

The scripts use only the repository's `dist-desklink/` paths shown above; none
accepts an alternate output or tarball directory. `pack.mjs` requires the
verified engine output and replaces older desklink tarballs with the current
`desklink-host-<version>.tgz` and `desklink-host-linux-x64-gnu-<version>.tgz`.
It cannot pack a host-only release and publishes nothing.
The package smoke instead uses `npm pack` on this checkout's host package as a
registry stand-in, without Docker or a native build. `check-install.sh` installs
only the current version's two tarballs into an empty project in a container
with no Rust toolchain, no display and no `/dev/uinput`, and checks both
installed versions. It checks the typed
missing-library error before installing the system runtime libraries, then has
the host package resolve the prebuilt engine, start it and answer the protocol
handshake and a capabilities probe.

Publishing is by hand, platform package first, so `@desklink/host` never points
at a version the registry does not have:

```sh
npm publish dist-desklink/desklink-host-linux-x64-gnu-<version>.tgz --access public
npm publish dist-desklink/desklink-host-<version>.tgz --access public
```
