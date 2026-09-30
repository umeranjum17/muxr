# Distribution and license inventory

Scope: the `muxr` npm CLI/host artifact produced by `node scripts/release/application/pack.mjs`.
The mobile app, development fixtures, APKs, and repository-only tooling are
not included in that artifact.

## Desktop engine

The desktop engine is **not** inlined into `host.js`. The artifact declares
`@desklink/host` (Apache-2.0) as an exact-pinned runtime dependency, and that
package declares its prebuilt engines as optional dependencies:
`@desklink/host-linux-x64-gnu` for Linux x64 with glibc and
`@desklink/host-darwin-arm64` for macOS arm64. npm installs only the matching
platform. The Linux package is desklink's own Apache-2.0 build of its engine crate, made from
pinned inputs by [`release/build-engine.sh`](https://github.com/umeranjum17/desklink/blob/main/packages/desktop-host/release/build-engine.sh) in
[umeranjum17/desklink](https://github.com/umeranjum17/desklink), and
the matching platform package supplies the only native executable a muxr install
adds for the desktop.

What the Linux executable contains:

| Component | License | How it is in the executable |
|---|---|---|
| desklink engine source | Apache-2.0 | compiled |
| libvpx (version pinned in `release/linux-x64-gnu.Dockerfile`) | BSD-3-Clause, with Google's patent grant | linked statically |
| inputtino (vendored under `engine/vendor/`) | MIT | linked statically |
| Rust standard library (version pinned in `release/linux-x64-gnu.Dockerfile`) | MIT OR Apache-2.0 | linked statically |
| Rust crates from `engine/Cargo.lock` | permissive licences checked by `release/notices.mjs`; exact set and texts in the platform package's generated `THIRD_PARTY_LICENSES.txt` | linked statically |

What the Linux executable loads from the system at run time and does not ship:
glibc (2.36 or newer), libstdc++ and libgcc_s (GCC Runtime Library Exception),
libpipewire-0.3,
libxkbcommon and libevdev (MIT). It calls the XDG desktop portal over D-Bus
rather than linking it. The platform package carries `THIRD_PARTY_LICENSES.txt`
with every licence text above and `COPYRIGHT-rust-library.html` for the standard
library's own notices.

The macOS engine links libvpx statically and uses Apple frameworks for capture,
input and H.264 encoding. Its platform package carries its own generated licence
notices and provenance. H.264 uses platform encoders loaded at runtime on both
platforms; muxr does not bundle those encoders.

The engine build is the licence gate for this part:
desklink's `release/notices.mjs` evaluates each crate's SPDX
expression, build-only crates included, and fails the build when one cannot be
satisfied by permissive licences alone; MPL, LGPL, GPL and AGPL all fail it.
The build also fails if libvpx ends up dynamically linked. The pinned input
versions and the exact licence inventory for a release are recorded in its
`provenance.json` and generated `THIRD_PARTY_LICENSES.txt`.

`@desklink/react-native` (the standalone React Native client) is not part of
this artifact; its Android code compiles against the `org.webrtc` classes the
app's existing `react-native-webrtc` ships.

## Product source ownership

Repository history attributes muxr-authored commits to Umer Anjum. The
mobile and relay foundations inherited MIT-licensed work from Happy, and parts
of the former lifecycle/notification model were derived from MIT-licensed PI
WEB. Those notices and the MIT terms remain in `NOTICE` and `LICENSES/MIT.txt`.
No contributor with a conflicting product-code license appears in repository
history.

muxr product code is distributed under `LICENSE`. Copies distributed
under an earlier license keep the rights that accompanied those copies.

## Published artifact

`pack.mjs` bundles `apps/host` plus the muxr contract and crypto workspaces,
and also bundles the relay entry (`apps/relay/dist/main.js`) so `muxr self-host`
can run from the packed CLI. The external runtime dependency list is owned by
[`runtimeDependencies` in pack.mjs](../scripts/release/application/pack.mjs).
Packing audits both bundled and external dependencies and generates
`THIRD_PARTY_LICENSES.json` with their versions, licenses, distribution status
and optional platform packages; full license texts are copied to `LICENSES/npm`.
Use that generated inventory for the release's exact dependency facts.
Packing fails on copyleft or unknown/non-approved dependency licenses.
Desktop native packaging is described under [Desktop engine](#desktop-engine).
The vendored file exception is
`resources/scrcpy/scrcpy-server-v4.0` (Genymobile scrcpy, Apache-2.0, pinned
SHA-256): a Dalvik jar the host pushes onto a task-owned emulator at preview
time. It never executes on the host, so it is data, not a native binary in
the artifact, and its notice lives in `NOTICE` with its hash beside it.

## Mobile artifact

The Android/iOS app is a separate distribution. Besides muxr product code it
ships:

| Component | License | Where |
|---|---|---|
| Inter, JetBrains Mono, IBM Plex, Space Mono, Bricolage Grotesque | SIL OFL 1.1 | `apps/mobile/**/assets/fonts/`, plus the native-terminal JetBrains Mono mirror at `apps/mobile/android/app/src/main/assets/`, `LICENSES/OFL-1.1.txt`, `NOTICE` |
| Whisper Base English (`ggml-base.en-q5_1.bin`) | MIT | `NOTICE` (OpenAI / whisper.cpp / whisper.rn) |
| xterm.js (+ addons) | MIT | packaged web terminal dependency, `NOTICE` |

This inventory does not replace store-release verification of native binaries.

## Automated gate

Every package build asks esbuild for an in-memory metafile, resolves each
`node_modules` input to the exact package copy that supplied it (including nested
copies), and audits both inlined and external runtime dependencies. Packaging
fails when a dependency has a missing, unknown/non-approved, GPL, LGPL, or AGPL
license, or when its license text cannot be found. The published output contains:

- `THIRD_PARTY_LICENSES.json` — package names, consumer-facing declared semver ranges, concrete locally audited install versions, licenses, and bundle status, without repository source paths;
- `LICENSES/npm/` — exact license text copied from each audited dependency.

The esbuild metafile and proprietary bundle input graph stay build-local and are
not included in the npm artifact.

The mobile/store distribution has a separate dependency and native-binary
surface and must receive its own verification before external store release.
