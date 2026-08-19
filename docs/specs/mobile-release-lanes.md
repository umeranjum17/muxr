---
title: Proven mobile release lanes
slug: mobile-release-lanes
status: tested
created: 2026-08-19
updated: 2026-08-19
owner: umer
links:
  - https://github.com/bluesky-social/social-app/blob/main/.github/workflows/build-submit-android.yml
  - https://github.com/bluesky-social/social-app/blob/main/.github/workflows/build-submit-ios.yml
---

# Proven mobile release lanes

## Context

The first muxr store release proved that local EAS builds can reach App Store Connect and Google Play, but the tag-only workflow mixed release creation, native builds, retries, and store delivery. Internal testing should be automatic for mobile-relevant merges, while public production remains a separate promotion of the exact binary already tested.

The replacement follows the MIT-licensed Bluesky mobile pattern: local EAS build, short-lived artifact handoff, and separate store submission jobs. Android submits through EAS. iOS uploads directly through Fastlane with the existing App Store Connect key so Expo queue latency cannot hold the workflow open. GitHub Actions remains the orchestrator because Android builds must stay local and muxr is a monorepo.

## Internal lane

- Trigger on mobile-relevant pushes to `main`, plus a manual per-platform retry.
- Serialize releases and coalesce superseded pending commits, run the existing mobile gate, and use EAS remote build counters with automatic increments.
- Build production-signed Android and iOS artifacts locally on the appropriate GitHub runners.
- Submit Android to Play Internal and wait until the exact version code appears through the Play API.
- Upload iOS directly to TestFlight; the automatic internal group receives the exact build after Apple processing.
- Retain artifacts and diagnostic logs briefly and write one release summary with version and build identifiers.

## Production lane

- Start as a manual workflow protected by the `production` GitHub environment.
- Require the exact tested Android version code and iOS build number.
- Promote Play Internal to Production and submit the existing TestFlight build for App Review without rebuilding.
- Keep automatic public release disabled initially. A future policy change may trigger the same promotion workflow after a successful internal lane.

## Reused open-source components

- Expo EAS CLI, MIT: local builds and initial store submission.
- Fastlane, MIT: direct TestFlight upload, Play track promotion, and App Store review submission.
- Bluesky social-app, MIT: architecture reference. muxr implements the pattern rather than vendoring its workflow.

## Files

- Replace `.github/workflows/stores.yml` with automatic internal and protected production workflows.
- Configure remote build counters in `apps/mobile/eas.json`.
- Add pinned Fastlane lanes and dependency metadata.
- Update `docs/RELEASING.md` with the two-lane operating procedure.

## Verification

- [x] Workflow YAML parses and action references are pinned.
- [x] Fastlane lanes load without contacting either store.
- [x] Existing build, typecheck, mobile integration, commerce, and secret checks pass.
- [x] Android local EAS build succeeds with a unique build number and the exact version code appears on Play Internal.
- [x] iOS local EAS build uploads, finishes Apple processing, and appears in the configured TestFlight group.
- [x] Production promotion requires the protected environment and reuses exact internal build identifiers.
