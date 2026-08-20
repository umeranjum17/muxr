---
title: Proven mobile release lanes
slug: mobile-release-lanes
status: implemented
created: 2026-08-19
updated: 2026-08-20
owner: umer
links:
  - https://docs.expo.dev/build/automate-submissions/
---

# Proven mobile release lanes

## Context

Mobile delivery must not depend on a merge, a workstation, or a locally available native toolchain. GitHub Actions remains the manual control plane while Expo performs signed Android and iOS builds in EAS Cloud. Internal testing and public production stay separate so production can promote the exact binary already tested.

## Internal testing lane

- Start manually from GitHub Actions with Android, iOS, or both selected.
- Run the existing mobile release gate before spending a cloud build.
- Trigger production-signed Android and iOS builds in EAS Cloud with remote automatic build-number increments.
- Auto-submit each newly created build to Play Internal or TestFlight and wait for EAS Build and EAS Submit to finish.
- Record the EAS build IDs, native version identifiers, and submission IDs in the GitHub summary.
- Serialize runs so two operators cannot race build numbers or submissions.

## Production lane

- Start manually through the protected `production` GitHub environment.
- Require the exact tested Android version code and iOS build number from the internal lane.
- Promote Play Internal to Production and submit the existing TestFlight build for App Review without rebuilding.
- Keep automatic public release disabled unless product policy explicitly changes.

## Reused open-source components

- Expo EAS CLI, MIT: cloud builds, exact build association, and internal store submission.
- Fastlane, MIT: Play track promotion and App Store review submission.
- GitHub Actions: manual orchestration, credential boundaries, summaries, and production approval.

## Files

- `.github/workflows/mobile-internal.yml`: manual verification, EAS Cloud build, and internal submission.
- `.github/workflows/mobile-production.yml`: protected exact-build production promotion.
- `apps/mobile/eas.json`: remote versioning and store submission profiles.
- `docs/RELEASING.md`: operator instructions for both manual lanes.

## Revisions

- 2026-08-20: Replace merge-triggered local EAS jobs with a manual GitHub workflow that builds and submits through EAS Cloud, removing release scheduling from source merges and native runners.

## Verification

- [x] Workflow YAML parses and all third-party actions remain SHA-pinned.
- [x] The mobile build, typecheck, integration, commerce, and secret checks pass.
- [x] Manual Android, iOS, and all-platform dispatch inputs map to the expected EAS Cloud platform.
- [ ] EAS Cloud reports finished builds and finished linked submissions.
- [x] Production remains protected and reuses exact internal build identifiers without rebuilding.
