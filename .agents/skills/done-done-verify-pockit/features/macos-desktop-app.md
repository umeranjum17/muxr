# Install the macOS desktop host and pair a terminal client

The Apple-silicon DMG carries the same host-side desktop pairing window as
the Linux AppImage. The paired phone or PWA, not the desktop host window,
opens terminals. Ad-hoc packaging and a trusted Developer ID release are
separate proofs; an ad-hoc build is never a Gatekeeper acceptance proof.

## Sub-features

- Local `yarn desktop:build:mac` produces an arm64 `.app` inside a `.dmg`,
  ad-hoc signed for local development, with the existing license audit.
- `yarn desktop:release:mac` requires a real Developer ID Application identity,
  uses hardened runtime and API-key notarization, staples both app and DMG,
  and fails if signing, notarization or Gatekeeper checks fail.
- Native macOS login-item integration replaces XDG autostart on macOS only.
- The installed host window pairs an isolated PWA; a real lab Herdr terminal
  shows live output in that paired client, with no renderer change.

## How to get to it (user POV)

Mount the DMG, drag muxr to Applications, and launch muxr. Pair a phone or
PWA using its QR/code and approve the same words on both sides. Open a lab
terminal from the paired client and see changing output.

## Driving it with the private stack

Preconditions: claim the Mac slot, use only task-owned state and a guarded
non-default Herdr lab. Follow `../SKILL.md` isolation and
`apps/desktop/MACOS.md`. Never install a service, access an owner's muxr
state, or touch foreign simulators. A developer proof may install under a
private task Applications folder and use `MUXR_DESKTOP_AUTOSTART=skip` so
it does not change the owner's login items. Set Electron's `--user-data-dir`
to private scratch as well as `MUXR_HOME`; pick the relay's actual port from
its child's own startup output, not an unrelated health response.

1. Build on an Apple-silicon Mac using `yarn desktop:build:mac`. Retain the
   build/license gate transcript and exact source commit.
2. Mount the generated DMG read-only using `hdiutil attach -readonly`, copy
   its `.app` with `ditto` into the private Applications folder, and detach
   the mounted volume. Record `file <app>/Contents/MacOS/muxr` (arm64).
3. Capture `codesign -dv --verbose=4`, `codesign --verify --deep --strict`,
   `spctl --assess --type execute -vv`, and `xcrun stapler validate` against
   the installed app. For an ad-hoc build, record Gatekeeper/stapler refusal
   as an expected limitation, **not** a passing production trust check.
   Do not disable Gatekeeper, remove quarantine, or change system policy.
4. Launch the installed executable with private `MUXR_HOME`, a non-owner
   relay port, private user-data directory, and the guarded Herdr lab.
   Capture the actual Ready-to-pair window without copying its pairing code
   into public logs. Pair a private lab PWA in a task-owned Mac browser
   profile through the real pairing/approval UI (see
   `lab-browser-pairing.md`). Capture host approval and the paired PWA Home.
5. Open a real lab terminal from that PWA. Run a bounded loop printing
   `Umer: live terminal 1`, `2`, `3` with one-second gaps. Capture the host
   window and the client terminal, plus a short motion recording showing
   output change. Inspect every shot before retaining it.
6. When the Developer ID identity exists, run `yarn desktop:release:mac`.
   Repeat install and launch with the real download quarantine attribute
   intact. Retain app and DMG trust checks and require acceptance plus
   valid stapled tickets; an ad-hoc capture cannot cover this step.
7. Stop only the recorded app/browser/lab child PIDs, tear down Herdr only
   through the guarded helper, verify no task processes remain, delete the
   task Mac scratch, and release the slot. Retain evidence outside scratch.

## Gotchas

- An App Store Connect API key can notarize but is not a Developer ID signing
  identity. Apple's certificate-creation API may refuse it with 403 and
  “This operation can only be performed by the Account Holder.” Stop there;
  never retry as another certificate type or request a password.
- A `.dmg` existing is packaging proof only; only actual `codesign`, `spctl`,
  notarization and stapling results prove trust.
- The Electron app is a **host**. Pairing the Electron window to another
  host or capturing a terminal inside its renderer would test a different
  product. The terminal proof belongs to its paired client.
