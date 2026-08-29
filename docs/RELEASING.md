# Releasing muxr

Pull requests and merges run the normal CI suite. npm publishes from a
protected tag workflow. Store binaries are built through remote EAS when a
store release is needed; production promotes those exact binaries without
rebuilding.

## Mobile

Run `.github/workflows/mobile-internal.yml` from the GitHub Actions **Run
workflow** button and choose Android, iOS, or all. It is not triggered by
pushes or merges. The workflow runs remote EAS builds and submits them to Play
Internal and TestFlight.

Production promotion uses `.github/workflows/mobile-production.yml` against the
successful internal run. It does not rebuild: Android promotes the existing
Play Internal release, and iOS submits the existing TestFlight build.

Keep signing and store credentials out of the repository.

## npm and GitHub releases

After the mobile build has been tested, bump `package.json`, update release
notes and version-pinned README downloads in a pull request, then publish the
matching GitHub release tag (`vX.Y.Z`). `.github/workflows/publish.yml`
verifies that the immutable tag matches the package version and publishes with
npm trusted publishing and provenance.

If the release event is interrupted before npm publishes, rerun it for the
existing tag:

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

All third-party GitHub Actions remain pinned to commit SHAs.
