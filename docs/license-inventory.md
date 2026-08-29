# Distribution and license inventory

Scope: the `muxr` npm CLI/host artifact produced by `node scripts/release/application/pack.mjs`.
The mobile app, development fixtures, APKs, and repository-only tooling are
not included in that artifact.

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
| `web-push` | MIT | No | external npm dependency |

There are currently no third-party packages inlined into `host.js` and no
native binaries in the npm artifact.

## Mobile artifact

The Android/iOS app is a separate distribution. Besides muxr product code it
ships:

| Component | License | Where |
|---|---|---|
| Inter, JetBrains Mono, IBM Plex, Space Mono, Bricolage Grotesque | SIL OFL 1.1 | `apps/mobile/**/assets/fonts/`, `LICENSES/OFL-1.1.txt`, `NOTICE` |
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
