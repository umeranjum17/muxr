# macOS desktop app (Apple silicon)

This is the same host-side pairing window as the Linux AppImage, not a
terminal client. It starts this Mac's host and relay; pair a phone or PWA to
it to open agents and terminals. No renderer redesign or auto-update.

## Local packaging

On an Apple-silicon Mac with Node 22+, Yarn 1 and Xcode command-line tools:

```sh
yarn install --frozen-lockfile --non-interactive
yarn desktop:build:mac
```

Outputs: `apps/desktop/release/mac-arm64/muxr.app` and
`apps/desktop/release/muxr-<version>-mac-arm64.dmg`. Mount the DMG and drag
muxr to Applications. This local build is **ad-hoc signed**, not Developer
ID signed or notarized: it is not a trusted public download. Never disable
Gatekeeper or describe this artifact as a production release.

## Trusted release

One owner prerequisite: install a usable **Developer ID Application**
certificate **with its matching private key** in this Mac's signing keychain.
Apple refused creation with the existing App Store Connect API key (403:
“This operation can only be performed by the Account Holder”). The Account
Holder must create it in Apple Developer → Certificates, Identifiers &
Profiles → Certificates → + → Developer ID Application, using a fresh CSR
from this Mac. Do not create another certificate type or reuse a CSR whose
private key was deleted. No password is requested by the release script.

After that account step and dependency installation, run:

```sh
yarn desktop:release:mac
```

The existing API inputs default to `~/.muxr/asc-key.p8`, `asc-key-id`, and
`asc-issuer-id`; alternatively set `APPLE_API_KEY` (file path),
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` in the environment without printing
them. This key is for notarization, **not** the app's signing identity.
`CSC_NAME` can select a particular existing Developer ID Application identity.

The command refuses a missing signing identity, builds through the same
license-audited packager, and uses electron-builder's existing macOS signing
and notarization support. It signs nested code with hardened runtime
(`codesign --options runtime`), submits the app using `notarytool submit
--wait`, then staples the app **before** creating the DMG. It signs the DMG,
submits and staples that too, and requires all of these checks to pass:

- `codesign --verify --deep --strict` and `codesign -dv --verbose=4` on the app;
- `xcrun stapler validate` on both app and DMG;
- `spctl --assess --type execute -vv` on the app;
- `spctl --assess --type open --context context:primary-signature -vv` on the DMG.

A missing credential, rejection, signing error or trust-check failure exits
nonzero. Nothing is published or uploaded except submissions to Apple's
notarization service. The Developer ID/notarization path remains unproven
until that prerequisite is supplied and this command succeeds on the Mac.
