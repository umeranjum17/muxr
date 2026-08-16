# Releasing muxr

CI runs the full suite on every push to `main` and every pull request. Publishing on every push would be unsafe because npm versions are immutable, so releases use a separate gate.

## One-time npm setup

After the package exists on npm, configure an npm **trusted publisher** for:

- repository: `umeranjum17/muxr`
- workflow: `publish.yml`
- environment: `npm`

The workflow uses GitHub OIDC (`id-token: write`) and npm provenance. Do not add a long-lived `NPM_TOKEN` repository secret. In GitHub, protect the `npm` environment so only the release branch or maintainers can approve it.

## Release flow

1. Bump `package.json` and update release notes in a pull request.
2. Wait for `.github/workflows/ci.yml` to pass.
3. Create and publish the matching GitHub release tag (`vX.Y.Z`).
4. `.github/workflows/publish.yml` verifies that the tag matches the package version, rebuilds the audited package, and publishes it with provenance. If that exact immutable version already exists, it exits successfully without republishing.
5. If the release event is interrupted before npm publishes, rerun the same protected gate for the existing immutable tag with `gh workflow run publish.yml -f tag=vX.Y.Z`. The workflow checks out that tag and re-verifies its version; it cannot publish a different tree under the version.
6. Verify anonymously:

   ```bash
   npm view @trymuxr/cli@X.Y.Z version dist.integrity repository.url
   npm install -g @trymuxr/cli@X.Y.Z
   muxr version
   muxr setup --help
   ```

Both workflows pin third-party actions to commit SHAs. Update those SHAs deliberately through reviewed pull requests.
