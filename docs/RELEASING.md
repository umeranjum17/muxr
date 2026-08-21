# Releasing muxr

Pull requests and merges run the normal CI suite. Mobile builds are deliberately manual: one workflow builds and deploys to internal testers, and a separately protected workflow promotes those exact binaries to production. npm releases remain a third independent gate.

## Mobile internal testing

Run `.github/workflows/mobile-internal.yml` from the GitHub Actions **Run workflow** button and choose Android, iOS, or all. It is not triggered by pushes or merges.

The workflow:

1. runs the mobile release gate before spending cloud capacity;
2. reserves unique EAS-managed `versionCode` and `buildNumber` values;
3. builds production-signed Android and iOS binaries in EAS Cloud;
4. auto-submits the newly created builds to Play Internal and TestFlight;
5. waits for the linked EAS Build and EAS Submit jobs to finish;
6. records native build identifiers plus EAS build and submission IDs in the GitHub summary.

Runs are serialized so two manual releases cannot race. Build progress and logs appear in the EAS dashboard; orchestration and the final summary appear in GitHub Actions. Neither lane depends on a workstation or local native toolchain.

The `stores` GitHub environment owns `EXPO_TOKEN` (preferred) or `EXPO_STATE_JSON` and `PLAY_SERVICE_ACCOUNT_JSON`. EAS owns the production signing credentials and App Store Connect submission key. Keep all credential material out of the repository.

## Mobile production promotion

Run `.github/workflows/mobile-production.yml` with the exact Android version code and iOS build number reported by a successful internal workflow. The protected `production` environment is a deliberate approval gate.

Production does not rebuild:

- Android promotes the existing Play Internal release to Production with the selected staged rollout.
- iOS selects the existing TestFlight build, uploads the supplied English release notes, and submits it for App Review. Automatic release after Apple approval is off by default.

The `production` environment owns the Play and App Store Connect API credentials. Removing its required reviewer later turns production into a policy change; keep the no-rebuild promotion lanes unchanged.

## npm and GitHub releases

After the mobile build has been tested, bump `package.json`, update release notes and version-pinned README downloads in a pull request, then publish the matching GitHub release tag (`vX.Y.Z`). `.github/workflows/publish.yml` verifies that the immutable tag matches the package version and publishes with npm trusted publishing and provenance.

If the release event is interrupted before npm publishes, rerun it for the existing tag:

```bash
gh workflow run publish.yml -f tag=vX.Y.Z
```

Verify anonymously:

```bash
npm view @trymuxr/cli@X.Y.Z version dist.integrity repository.url
npm install -g --ignore-scripts @trymuxr/cli@X.Y.Z
muxr version
muxr setup --help

tmp=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/umeranjum17/muxr/main/install.sh -o "$tmp"
sh -n "$tmp"
cmp install.sh "$tmp"
rm -f "$tmp"
```

The `npm` environment must keep its required reviewer and branch policy. All third-party GitHub Actions remain pinned to commit SHAs.
