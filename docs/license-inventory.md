# Distribution and license inventory

Scope: the `muxr` npm CLI/host artifact produced by `node scripts/release/application/pack.mjs`.
The mobile app, development fixtures, APKs, and repository-only tooling are
not included in that artifact.

## Desktop engine

`packages/desktop-host` is **not** inlined into `host.js`. The artifact declares
`@desklink/host` (Apache-2.0) as an exact-pinned runtime dependency, and that
package declares its prebuilt engine as the optional dependency
`@desklink/host-linux-x64-gnu`, which npm installs only on Linux x64 with glibc.
That package is desklink's own Apache-2.0 build of `packages/desktop-host/engine`,
made from pinned inputs by `packages/desktop-host/release/build-engine.sh`, and
it is the only native executable a muxr install adds for the desktop.

What the executable contains:

| Component | License | How it is in the executable |
|---|---|---|
| desklink engine source | Apache-2.0 | compiled |
| libvpx v1.16.0 (`1024874c`) | BSD-3-Clause, with Google's patent grant | linked statically |
| inputtino (vendored at `f4ce2b0d`, unmodified) | MIT | linked statically |
| Rust standard library 1.97.1 | MIT OR Apache-2.0 | linked statically |
| 245 crates from `engine/Cargo.lock` | every one satisfiable by Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, Unicode-3.0, Unlicense or Zlib (one uses the LLVM exception) | linked statically |

What it loads from the system at run time and does not ship: glibc (2.36 or
newer), libstdc++ and libgcc_s (GCC Runtime Library Exception), libpipewire-0.3,
libxkbcommon and libevdev (MIT). It calls the XDG desktop portal over D-Bus
rather than linking it. The platform package carries `THIRD_PARTY_LICENSES.txt`
with every licence text above and `COPYRIGHT-rust-library.html` for the standard
library's own notices.

The engine build is the licence gate for this part:
`packages/desktop-host/release/notices.mjs` evaluates each crate's SPDX
expression, build-only crates included (277 in all), and fails the build when one
cannot be satisfied by permissive licences alone; MPL, LGPL, GPL and AGPL all
fail it. The build also fails if libvpx ends up dynamically linked. Checked at
this revision of `Cargo.lock`: every crate passes, and inputtino's vendored
`LICENSE` is still MIT.

`packages/desktop-client` (the standalone React Native client) is not part of
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
can run from the packed CLI. It declares these external runtime packages:

| Package | License | Native binary | Distribution |
|---|---|---:|---|
| `ws` | MIT | No | external npm dependency |
| `tweetnacl` | Unlicense | No | external npm dependency |
| `qrcode` | MIT | No | external npm dependency |
| `web-push` | MPL-2.0 | No | external npm dependency |
| `bonjour-service` | MIT | No | external npm dependency |
| `ccusage` | MIT | Through its optional per-platform packages | external npm dependency |
| `@desklink/host` | Apache-2.0 | Through its optional `@desklink/host-linux-x64-gnu` ([Desktop engine](#desktop-engine)) | external npm dependency, exact version |

There are currently no third-party packages inlined into `host.js` and no
native binaries in the npm artifact itself; the native executables arrive as
the optional platform packages above, which `THIRD_PARTY_LICENSES.json` lists
with the package that brings them in.

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
