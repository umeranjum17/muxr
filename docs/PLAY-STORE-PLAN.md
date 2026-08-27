# Google Play launch plan

Status: **Play Console app is live; signed store artifacts are built through the manual EAS Cloud internal-testing workflow.** Production package ID is permanently `com.trymuxr.app`.

## 1. Freeze the release identity

- Package/application ID: `com.trymuxr.app` (immutable after first upload).
- Store title: **muxr**.
- Category: **Productivity**.
- Marketing version: `0.1.12` in `apps/mobile/app.config.js`; EAS owns the monotonically increasing remote `versionCode`. Never reuse a consumed code.
- Production App-Link origin: `https://trymuxr.com`.
- Keep preview/dev identifiers separate. Never sign preview and production with the same upload workflow by accident.

## 2. Establish signing and verified links

1. Create the app in Play Console with `com.trymuxr.app` and opt into Play App Signing.
2. Generate a dedicated RSA upload key (2048-bit minimum), never commit it, and back it up in two encrypted owner-controlled locations. Keep passwords outside shell history and CI logs.
3. Configure EAS credentials to sign cloud-built upload AABs with that key.
4. After Play exposes the **app-signing certificate** SHA-256 fingerprint, configure the trymuxr.com service with `MUXR_ANDROID_CERT_FINGERPRINTS`. Use the Play signing certificate—not merely the upload certificate.
5. Verify `https://trymuxr.com/.well-known/assetlinks.json` returns `com.trymuxr.app` plus the exact Play signing fingerprint, with 200 status, JSON content type, no redirect, and no authentication.
6. Install a Play-delivered build and prove a `/pair` HTTPS link opens muxr directly. A locally signed APK proves only the upload/development certificate path.

Google requires Android App Bundles for new apps and recommends separate upload and app-signing keys: [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756) and [Android App Bundles](https://developer.android.com/guide/app-bundle).

## 3. Build the exact store artifact in EAS Cloud

Run the `mobile internal testing` workflow manually from GitHub Actions and
select Android or all platforms. The workflow verifies the source, triggers the
production profile in EAS Cloud, submits the resulting AAB to Play Internal,
and records its exact version code and EAS build identifier.

Before submission:

- `yarn run check` passes.
- Build metadata points at the release commit and the working tree is clean.
- Bundle targets API 36, contains `arm64-v8a`, and includes no unsupported 32-bit ABI without its corresponding 64-bit ABI.
- Use `bundletool` to generate/install device APKs from the AAB and run the clean-room smoke on API 36.
- Inspect merged release manifest and bundle permissions.
- Confirm Play's generated per-device download remains under its 200 MB compressed limit. The current ARM64 APK is about 174 MB, so this is a real gate, not paperwork.
- Save AAB/APK SHA-256 checksums, signing-certificate fingerprints, native debug symbols, and any R8 mapping with the release evidence. Never publish the upload keystore.

Starting August 31, 2026, new phone apps and updates must target Android 16/API 36: [target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878). Google Play requires 64-bit support for native apps: [64-bit architectures](https://developer.android.com/games/optimize/64-bit).

## 4. Permission and policy audit

The release should request only what users can reach:

| Permission/surface | User-visible reason | Play work |
|---|---|---|
| Camera | Scan a self-hosted pairing QR | Runtime rationale and privacy-policy disclosure |
| Microphone | Explicit dictation or realtime voice | Runtime rationale; microphone FGS declaration and video |
| Notifications | Waiting, completion, connection, and Live Update state | Runtime consent; promoted notifications remain optional |
| Network/Wi-Fi state | Reach and discover the user's relay | Explain self-hosted LAN/Tailscale behavior |
| Internet | Encrypted relay and optional provider stream | Data-safety inventory |

Location, calendar, media-library, activity-recognition, and background-media-playback declarations have been removed. The app-owned foreground-service types are `microphone` for an explicit user-started voice session and `dataSync` while an active Herd keeps encrypted agent state current; the service stops when the Herd settles and handles Android's API 35 timeout. In Play Console → App content → Foreground service permissions, describe both flows, why interruption breaks the live experience, how the user stops them, and attach a public video showing start, persistent notification, background operation, and stop. Google reviews each declared FGS type: [foreground-service requirements](https://support.google.com/googleplay/android-developer/answer/13392821).

Re-check the final merged AAB rather than trusting `app.config.js`; native Android files are tracked and are the submission source of truth.

## 5. App content declarations

Complete these conservatively against the exact submitted bundle:

- **Privacy policy:** `https://trymuxr.com/docs/privacy`, public without login, clearly titled Privacy Policy, naming muxr/developer contact, self-hosted data flow, retention/deletion, optional AI provider disclosure, and security practices. Link the same policy inside the app.
- **Data safety:** inventory app code and every SDK. muxr has no ads or analytics and the developer does not operate the user's relay, but terminal/file content, app activity, device identifiers, crash/support exports, microphone audio, and optional provider forwarding must still be assessed under Google's definitions. Treat optional voice-provider transfer as third-party AI processing; do not claim “no data collected” without validating the full flow.
- **Ads:** No.
- **Target audience:** adults/general productivity; do not target children.
- **Content rating:** complete IARC for a coding/terminal companion with user-provided text, no social feed, gambling, sexual content, or ads. Update if plugin distribution changes exposure.
- **Account deletion:** the Play build has no muxr account. State this accurately; document deleting paired-device authorization and self-hosted state rather than inventing a web account flow.
- **App access:** no paid credentials, account, CLI installation, repository, or reviewer-owned computer is required. Put the private bounded invitation URL in Play Console's App access instructions. The invitation page mints a fresh standard two-minute pairing string for the live disposable Herdr review computer; if it expires, the same durable page produces another. Include the exact `Review-Workspace → Otter → Create review.txt containing hello` script and expected result. Keep the invitation valid, reusable, location-independent, monitored, and private for the entire review window; never publish it in listing copy, screenshots, or source control.
- **Government, news, health, financial, ads-ID, and Families declarations:** No/not applicable unless the product materially changes.

Google requires a Data safety form even when an app collects no data, and its 2026 guidance explicitly covers third-party AI integrations: [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469). Privacy policies and app-access instructions are covered by [User Data](https://support.google.com/googleplay/android-developer/answer/10144311) and [Prepare your app for review](https://support.google.com/googleplay/android-developer/answer/9859455).

## 6. Store listing and assets

Proposed copy:

- **Title:** `muxr`
- **Short description:** `Control every coding agent from your phone—open source and self-hosted.`
- **Opening full-description line:** `Leave the desk, not the work. muxr puts every Herdr coding-agent pane, terminal, file, change, attachment, and plugin on your phone.`
- **Support:** `https://trymuxr.com/docs/troubleshooting`
- **Website:** `https://trymuxr.com`
- **Privacy:** `https://trymuxr.com/docs/privacy`

Prepared assets live in `docs/play/store-assets/`:

- `store-icon.png`: 512×512 RGBA PNG.
- `feature-graphic.png`: 1024×500 opaque PNG, no device imagery.
- `01-herd.png` through `08-live-update.png`: candidate 1080×1920 marketing screenshots. Re-capture any frame that is stale, exposes private paths or internal state, or cannot be traced to current app UI before upload.

Upload all eight in this sequence: Herd, Terminal, Plugins, Files, Changes, Runbook, Voice, Live Update. Google accepts up to eight and requires each dimension to be 320–3840 px with the long side no more than twice the short side: [preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151).

## 7. Track sequence

1. **Internal testing:** upload the signed AAB, resolve automated pre-launch report issues, test Play-delivered splits, App Links, upgrade, notifications, camera, microphone FGS, revoke, and uninstall.
2. **Closed testing:** if this is a personal developer account created after November 13, 2023, keep at least 12 opted-in testers continuously enrolled for 14 days, collect feedback, then apply for production access. Confirm the requirement shown in this specific Play Console account; organization/older accounts may differ. [Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465).
3. **Production:** submit only after clean-room smoke and public GitHub release pass. Start with a small staged rollout, monitor Android vitals/reviews, then expand. Do not add analytics merely to measure launch; Play Console vitals and direct issue reports are enough initially.

## 8. Release gate

All boxes are blockers:

- [ ] Public repository/history decision complete; release tag and source archive exist.
- [ ] Paid subscribers wound down before the no-paid site deploy.
- [ ] trymuxr.com static site deployed; checkout/account/control-plane routes are 404.
- [ ] Upload key backed up; Play App Signing active.
- [ ] Play signing SHA configured in `assetlinks.json`; Play-delivered App Link verified.
- [ ] Exact current-main AAB from the successful internal EAS workflow downloaded, inspected, checksummed, and matched to its recorded commit and version code.
- [ ] Clean-room new-user smoke passes from public artifacts.
- [ ] FGS video and all App content/Data safety declarations submitted.
- [ ] Store listing assets and support/privacy URLs accepted.
- [ ] Required closed test and production-access application complete.
- [ ] Staged production rollout approved by the owner.
