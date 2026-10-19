# trymuxr.com

The muxr website: landing films, setup and privacy docs, pairing guidance,
and downloads resolved from the public release catalog. No account service
or App Review invite broker is included.

From the repository root (Node.js 22+):

```sh
yarn install --frozen-lockfile
yarn workspace @trymuxr/site build
yarn workspace @trymuxr/site test
yarn workspace @trymuxr/site start
```

The server listens on `PORT` (default `8080`). `/ready` is its health endpoint.
Android association reads `MUXR_APP_ID_BASE` and
`MUXR_ANDROID_CERT_FINGERPRINTS` (or `MUXR_ANDROID_SHA256_CERT_FINGERPRINTS`).
Apple association reads `MUXR_APP_ID_BASE` and `MUXR_APPLE_TEAM_ID`.
Unconfigured association endpoints return 404.

## Assets

Media is checksum-locked in `marketing.lock.json`. Identical assets already
tracked elsewhere in muxr are relative symlinks, not additional copies.
Keep the repository layout intact when serving the site.
`yarn workspace @trymuxr/site marketing:check` verifies every locked output.
`marketing:sync --source <muxr checkout> --ref <commit>` refreshes source art;
film, herd and crop scripts accept their source inputs explicitly. These
regeneration tools also require their declared image, font and video CLIs.
Strip JPEG metadata before updating the asset lock.

## Container and deployment

Build **from the repository root**, not `apps/site`, so reused assets are in
context. The Dockerfile-specific ignore file restricts that context to site
inputs and shared media:

```sh
docker build --file apps/site/Dockerfile --tag trymuxr-site .
docker run --rm --publish 8080:8080 trymuxr-site
```

`.github/workflows/deploy-trymuxr.yml` runs on `main` in this repository, on
every merge that changes the site image (the paths it lists are what the
Dockerfile copies) and on manual dispatch, and binds to the `trymuxr` GitHub
environment. It builds, tests and smoke-checks the image before requesting
deployment and checking health.

Before using it, the owner must create that environment with required owner
approval and a `main`-only deployment rule. Set these **environment secrets**
(no repository variables): `COOLIFY_TOKEN` (a newly issued token),
`COOLIFY_URL`, `COOLIFY_WEB_APP_UUID`, `COOLIFY_WEB_HEALTH_URL`.
No secret values belong in source, documentation or logs.

The owner must separately repoint the deployment app at this public repository
on `main`, with repository-root build context and `apps/site/Dockerfile`, and
leave the app's own automatic deployment off (this workflow is the trigger).
Until then the existing site is unchanged.
The workflow does not configure the environment, rotate credentials or change
the deployment app. The old repository and App Review broker stay private.
