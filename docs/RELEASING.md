# Releasing muxr

Pull requests run the normal CI suite. Mobile-relevant merges to `main` additionally build production-signed binaries and send them to internal testers. Public store promotion and immutable npm releases remain separate gates.

## Mobile internal testing

`.github/workflows/mobile-internal.yml` follows the same local EAS build → artifact → submit pattern used by Bluesky's mobile app, while current EAS Submit handles the internal TestFlight group with its existing App Store Connect key.

A push to `main` triggers it when mobile code, shared wire/contract packages, bundled plugins, native patches, or mobile build policy changes. It can also be rerun manually for Android, iOS, or both. Releases are serialized; if several merges arrive while one build is running, GitHub keeps the running build and the newest pending commit rather than spending store builds on superseded intermediate commits.

The workflow:

1. runs the mobile release gate;
2. reserves unique EAS-managed `versionCode` and `buildNumber` values;
3. builds the production-signed AAB and IPA locally on GitHub runners;
4. submits Android to Play Internal and waits until that exact version code appears on the track;
5. submits iOS, waits for Apple processing, and assigns that exact build to the internal TestFlight group;
6. records both identifiers in the GitHub job summary.

The `stores` GitHub environment owns `EXPO_TOKEN` (preferred) or `EXPO_STATE_JSON` and `PLAY_SERVICE_ACCOUNT_JSON`. EAS owns the existing App Store Connect key and maintains the automatic `Team (Expo)` internal tester group. Keep all credential material out of the repository.

## Mobile production promotion

Run `.github/workflows/mobile-production.yml` with the exact Android version code and iOS build number reported by a successful internal workflow. The protected `production` environment is a deliberate approval gate.

Production does not rebuild:

- Android promotes the existing Play Internal release to Production with the selected staged rollout.
- iOS selects the existing TestFlight build, uploads the supplied English release notes, and submits it for App Review. Automatic release after Apple approval is off by default.

The `production` environment owns the same Play and App Store Connect API credentials. Removing its required reviewer later turns production into a policy change; keep the no-rebuild promotion lanes unchanged.

## npm and GitHub releases

After the mobile build has been tested, bump `package.json`, update release notes and version-pinned README downloads in a pull request, then publish the matching GitHub release tag (`vX.Y.Z`). `.github/workflows/publish.yml` verifies that the immutable tag matches the package version and publishes with npm trusted publishing and provenance.

If the release event is interrupted before npm publishes, rerun it for the existing tag:

```bash
gh workflow run publish.yml -f tag=vX.Y.Z
```

Verify anonymously:

```bash
npm view @trymuxr/cli@X.Y.Z version dist.integrity repository.url
npm install -g @trymuxr/cli@X.Y.Z
muxr version
muxr setup --help
```

The `npm` environment must keep its required reviewer and branch policy. All third-party GitHub Actions remain pinned to commit SHAs.
