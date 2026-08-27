# Mobile store review packet

Status: draft for the next current-main internal build. Nothing in this file authorizes a build, upload, console edit, review submission, or production promotion.

## App Review notes draft

muxr is an open-source companion for Herdr coding-agent sessions running on a Mac or Linux computer controlled by the reviewer. The iOS and Android apps do not create a muxr user account and do not require demo credentials. A paired computer remains the source of truth for agents, terminals, repositories, plugins, and optional provider credentials.

### Reviewer setup

1. On a disposable Mac or Linux test computer, install the matching public CLI release:

   ```sh
   npm install -g @trymuxr/cli
   muxr
   ```

2. Choose **Set up or repair this machine**, select a connection method reachable by the phone, and review the plan before applying it.
3. In the mobile app, open **Settings → Pair another machine** and scan the one-use QR code shown by the CLI. Pairing claims expire and cannot be reused.
4. Use a disposable Git repository. Start a shell or an installed coding agent from **New session**.
5. Verify the Herd, live terminal, file browser, changes, runbook, notification, revocation, and reconnect surfaces. No paid provider key is needed for these features.

Public setup details: https://trymuxr.com/docs/setup

Support: https://github.com/umeranjum17/muxr/issues

Privacy: https://trymuxr.com/docs/privacy

### Non-obvious behavior

- Terminal text, prompts, files, attachments, and pairing traffic use the app's end-to-end encrypted protocol. The relay routes ciphertext and cannot read this content.
- Local-network access is used to discover and connect to a self-hosted relay.
- Camera access is used only to scan a pairing QR code.
- Photo-library access is used only when the user chooses an image attachment.
- Microphone access is used for explicit dictation or realtime voice. Realtime voice is optional and requires a backend provider configured by the user on the paired computer; no provider credential is bundled in the app.
- iOS background audio is used only while an explicit realtime voice session or bounded wake-on-speech mode is active. Remote-notification background mode supports agent completion and attention notifications.
- Android starts its microphone foreground service before opening realtime capture. Its persistent notification exposes stop/mute controls.
- There is no muxr account to delete. Users remove access by revoking the paired device, resetting muxr state, or uninstalling the app. Self-hosted computer and relay data remain under the user's control.

### Review contact

Use the public support issue tracker for ordinary review questions. Security-sensitive material must use the private security-advisory route linked from the privacy policy. Never place a reusable pairing claim, device credential, provider key, or privileged repository in review notes.

## Revocable reviewer sandbox design

The reviewer should receive one durable invite URL, not a short-lived pairing claim and not owner credentials. The smallest safe design is:

1. An owner creates an invite record with a random opaque token, explicit expiry, revocation flag, maximum redemption count, and a fixed reviewer-sandbox target.
2. Opening the invite as a Universal Link launches muxr. The app presents its newly generated device public key to the redemption endpoint.
3. The endpoint atomically validates the invite and asks the isolated sandbox host to mint a fresh standard one-use pairing claim. The short-lived claim is created only at redemption time, so asynchronous App Review does not consume its lifetime.
4. The app immediately completes the normal pairing protocol. A redeemed invite cannot mint a second grant unless its policy explicitly permits one reinstall.
5. Revoking or expiring the invite revokes every grant it minted. Bounded audit events record only creation, redemption, expiry, and revocation outcomes.

The sandbox must be a separate, resettable host with network egress denied and no owner account, source repository, terminal, provider key, or machine credential. It serves only synthetic session states, prerecorded terminal/file/diff fixtures, and a deterministic synthetic voice stream. Write actions mutate disposable in-memory fixture state; they never reach a shell. The UI must identify the connection as review content without exposing internal identifiers.

This design needs a threat-model and implementation review before deployment. Do not place a permanent privileged token in App Store Connect.


## Privacy and Data Safety draft

These are evidence-backed draft answers, not legal attestations. The account holder must confirm final Apple and Google forms against the exact submitted binaries and deployed services.

| Data class | Current behavior and source evidence | Conservative draft answer |
| --- | --- | --- |
| Tracking/advertising | No ads, analytics SDK, IDFA use, or cross-app tracking is configured. | Tracking: No. Advertising: No. |
| Device identifiers | Pairing creates revocable device credentials. iOS obtains an Expo push token and registers it with the selected relay for notifications. | Disclose device identifiers used for app functionality; not for tracking. |
| Terminal, prompts, files, and attachments | App content is transmitted through the relay as E2EE ciphertext to the user's paired computer. The relay cannot decrypt it. | Google: apply the E2EE exclusion only after confirming every intermediary lacks keys. Apple: confirm whether the exact transfer qualifies for an App Privacy disclosure exemption; otherwise disclose User Content for app functionality. |
| Photos | User-selected images are normalized and attached to a session; media-library access is not background or bulk access. | Optional, user initiated, app functionality. No advertising or tracking. |
| Microphone audio | Dictation can remain on-device. Optional realtime voice sends audio to the provider configured by the user on the paired computer. | Disclose Audio Data conservatively as optional app functionality and third-party processing unless counsel confirms a user-initiated/service-provider exemption. |
| Relay metadata | Relay operation can process network address, connection timing, routing identifiers, ciphertext size, and managed authorization records. | Assess device identifiers and diagnostics/other data against the deployed relay, retention, and operator role. |
| Diagnostics/support | The app exposes redacted diagnostics. No automatic crash/analytics upload was found; a user may choose to send support information. | User-initiated support only; do not claim automatic diagnostics collection. |
| Encryption in transit | Production cloud endpoints use TLS; app content normally uses muxr E2EE even through self-hosted transport. | Google encrypted-in-transit answer: Yes, after exact-binary/network verification. |
| Deletion | Revoke paired devices, reset muxr, uninstall the app, and remove self-hosted state. The app does not create an app account. | Account creation: No. Provide the privacy deletion section as the privacy-choices/data-deletion resource. |

### Export compliance draft

The app uses published, standard cryptography through platform TLS and libsodium-based E2EE; no proprietary or unpublished algorithm was found. The source currently declares `ITSAppUsesNonExemptEncryption` as false. Draft answer: the app uses only exempt encryption. The account holder or export counsel must confirm the classification and any annual reporting/documentation requirement before submission.

### Permission declarations

| Platform permission | User-visible use | Evidence state |
| --- | --- | --- |
| iOS microphone | Explicit dictation and realtime voice | Purpose string present; real-device routing/background behavior still requires external TestFlight evidence. |
| iOS camera | Scan one-use pairing QR | Purpose string and camera flow present. |
| iOS local network/Bonjour | Discover and reach a self-hosted relay | Purpose string and Bonjour services present. |
| iOS photo library | Select image attachments | Purpose string and picker flow present. |
| iOS notifications/APNs | Completion and attention alerts | Production entitlement and registration flow present; real delivery requires a physical tester. |
| iOS Face ID/biometrics | Secure credential storage if authentication is enabled | Purpose string is present; confirm the submitted binary does not prompt outside a user-initiated secure-store flow. |
| Android microphone FGS | Explicit realtime capture/wake-on-speech | `microphone` service type and permission present; service-before-capture source invariant exists. |
| Android dataSync FGS | Keep active Herd state current in background | Requires Play policy review, declaration text, and a public demonstration video. |
| Android camera/notifications/network | Pairing, alerts, and relay connectivity | Present in the exact historical AAB; re-inspect the new AAB. |

## Metadata inventory

Canonical App Store metadata is under `metadata/` and must pass `asc metadata validate --dir ./metadata` before any dry run. App Review details, age rating, category, App Privacy, export compliance, screenshots, content rights, pricing, and availability remain separate App Store Connect resources.

Draft defaults:

- Primary locale: `en-US`
- Marketing version: `0.1.12`
- Category proposal: Productivity
- Account creation: No
- Ads: No
- Tracking: No
- Automatic iOS release: Off
- Support URL: https://github.com/umeranjum17/muxr/issues
- Privacy URL: https://trymuxr.com/docs/privacy
- Privacy choices/deletion URL: https://trymuxr.com/docs/privacy#retention-and-deletion

Before review, run:

```sh
asc metadata validate --dir ./metadata --output table
asc validate --app com.trymuxr.app --version 0.1.12 --platform IOS --output table --strict
asc review doctor --app com.trymuxr.app --version 0.1.12 --platform IOS --output table
```

The last two commands require approved read-only App Store Connect authentication. They do not authorize applying metadata or submitting for review.

## Screenshot inventory

### App Store

| Set | Files | Format gate | Release gate |
| --- | --- | --- | --- |
| iPhone 6.9-inch | Six raw PNG captures and six 1320×2868 opaque sRGB JPEGs | Pixel/format slot accepted by current Apple specifications | Not ready: recapture from the exact frozen release commit; the Settings capture exposes an older host version. |
| iPad 13-inch | Six separate raw PNG captures and six 2064×2752 opaque sRGB JPEGs | Required because the binary declares iPad support; current pixel slot accepted | Not ready: recapture from the exact frozen release commit; the Settings capture exposes an older host version. |

### Google Play

| Asset | Format gate | Release gate |
| --- | --- | --- |
| Store icon | 512×512 PNG with alpha | Format ready; console presence unverified. |
| Feature graphic | 1024×500 opaque PNG, no device image | Format ready; broad marketing claim needs owner approval. |
| Eight phone screenshots | 1080×1920 opaque PNG | Not ready: several contain a private home-directory path or source-state fragments; the plugin example is not a clean first-run surface; color profiles are not embedded. |
| Owner-provided realtime capture | Runtime error visible: `stream control frame rejected` | Rejected. The failing plugin-stream control path is shared JavaScript, not Android-only; the next iOS and Android candidates must both contain the Linux-owned sync-client fix and pass the realtime flow. Do not crop, cover, or rewrite the error in artwork. |

No screenshot is eligible merely because its dimensions pass. Each final asset must show authentic current-build UI, synthetic public data, no internal identifiers or private paths, and behavior proven by the frozen release candidate.

## Minimum reliable store automation

Keep internal testing and production promotion as separate protected workflows. Every candidate record must bind the workflow run, source commit, marketing version, native build identifier, build job, submission job, final processing state, and store lane.

### Apple

1. Build with Xcode 26 through the approved EAS production profile. EAS Submit uploads to TestFlight only; it does not submit to App Review.
2. Poll the exact build until App Store Connect reports `VALID`:

   ```sh
   asc builds info --app com.trymuxr.app --build-number <BUILD> --version 0.1.12 --platform IOS --output table
   ```

3. Validate local metadata, produce review plans, and stop before apply:

   ```sh
   asc metadata validate --dir ./metadata --output table
   asc metadata plan --app com.trymuxr.app --version 0.1.12 --platform IOS --dir ./metadata --review-dir .asc/metadata/review
   asc screenshots plan --app com.trymuxr.app --version 0.1.12 --review-output-dir ./screenshots/review --output json
   ```

4. Run the canonical readiness gates:

   ```sh
   asc validate --app com.trymuxr.app --version 0.1.12 --platform IOS --output table --strict
   asc review doctor --app com.trymuxr.app --version 0.1.12 --platform IOS --output table
   ```

5. The protected production job selects the already-tested TestFlight build and stops at its required reviewer. Only after approval may fastlane or the App Store Connect `appStoreVersionSubmissions` API perform the equivalent of **Submit for Review**.
6. Poll review state with `asc review status`/`asc review history`. Keep automatic release off. For later updates, App Store Connect phased-release APIs can create, pause, resume, or immediately complete a phased release. They are unavailable for the first version. After public release there is no binary rollback; pause a phased release when possible or submit a corrected higher build/version.

Xcode/Transporter can upload a signed binary with App Store Connect JWT authentication. `asc`, fastlane, and the App Store Connect API cover metadata, build selection, validation, review submission, polling, and release controls. For this repository, EAS remains the signing/upload owner and the protected no-rebuild fastlane lane remains the production owner; adding a second uploader would create unnecessary credential and provenance paths.

### Google Play

The Google Play Developer Publishing API uses transactional edits for bundles, tracks, listings, graphics, and screenshots. EAS uploads the candidate to Internal; the protected fastlane lane verifies the exact Internal `versionCode` and promotes that artifact without rebuilding. A production rollout must stop at the required reviewer, start staged, and be halted through Play/fastlane if metrics regress. A fully completed rollout cannot restore an older binary as a new release; recovery requires a higher `versionCode`.

### Hard stop

StoreKit test sessions, Apple Sandbox, TestFlight, Play Internal, and pre-launch reports validate product behavior and distribution mechanics. None can impersonate App Review or prove that Apple/Google will accept metadata, privacy attestations, reviewer access, or policy use. Automation must stop before metadata apply, screenshot upload, build upload, review submission, or production promotion unless the owner explicitly approves that exact mutation.
