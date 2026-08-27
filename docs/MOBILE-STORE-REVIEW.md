# Mobile store review packet

Status: pre-submission packet for mobile 0.1.12 from frozen source `bccd0e0a`. Internal/TestFlight uploads and safe console preparation are complete or in progress. App Review submission and Play Production promotion still require explicit owner approval.

Frozen candidate evidence:

- Internal workflow: `33041924776` (successful)
- Android: versionCode `43`, EAS build `2df4e076-9273-453b-bb94-62cf41338961`, Play Internal completed
- iOS: buildNumber `40`, EAS build `34eb0c30-dc0c-4842-9bd4-6976fed4b249`, uploaded to App Store Connect
- Both EAS build records report `FINISHED`, Store distribution, production profile, and exact Git commit `bccd0e0a65b987f85a0b011ea317454c74bace88`

## App Review notes draft

muxr is an open-source companion for Herdr coding-agent sessions running on a Mac or Linux computer. App Review does not need an account, purchase, CLI installation, repository, or computer setup. A private, durable invitation opens access to a live disposable review computer containing only synthetic data.

### Reviewer setup

1. Open the private invitation URL supplied in **App Review Information** or **Play App access**.
2. Tap **Copy pairing string**. The page creates a fresh standard two-minute pairing string without exposing owner credentials.
3. In muxr, tap **Enter pairing string**, paste the value, review the disclosed permissions, and tap **Pair**. If the string expires, revisit the same invitation page for a fresh value; the invitation remains valid throughout review.
4. Open **Review-Workspace → Otter**.
5. Send `Create review.txt containing hello`.
6. Expected result: the terminal confirms that `review.txt` was created and the change was recorded. The same synthetic workspace supports terminal input, file browsing, change review, attachments, reconnect, and notification flows.

The sandbox runs real Herdr and muxr transport against a disposable repository. It contains no owner account, source repository, terminal history, provider credential, or production secret. Optional realtime voice requires a provider configured by the computer owner and is intentionally not configured in the credential-free review sandbox; local dictation remains available.

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

Use the public support issue tracker for ordinary review questions. Security-sensitive material must use the private security-advisory route linked from the privacy policy. The bounded invitation URL belongs only in the stores' private reviewer-access fields; never publish it in listing copy, screenshots, source control, or public documentation. Never place a device credential, provider key, owner repository, or permanent privileged grant in review notes.

## Deployed reviewer sandbox

The deployed review system deliberately reuses muxr's normal pairing and E2EE grant flow:

1. A private, high-entropy invitation has an explicit expiry and claim cap.
2. The invitation broker stores only the token hash and returns a fresh standard two-minute pairing string.
3. The reviewer approves the normal mobile pairing disclosure and receives a revocable device grant.
4. The target is an isolated review computer running real Herdr, muxr, and a deterministic review agent against a disposable synthetic repository.
5. A scheduled reset restores the repository baseline. A watchdog keeps the review agent and invitation services online throughout the review window.

The sandbox is separate from owner computers and contains no personal data, owner repository, cloud credential, AI subscription, or production secret. The deterministic agent accepts a bounded test vocabulary while exercising the real terminal, file, change, attachment, notification, and reconnect surfaces. The private invitation is rotated or revoked after review, test-device grants are removed, and the sandbox is reset before each submission.


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
| Store icon | 512×512 PNG with alpha | Approved unchanged for the Play icon slot. |
| Feature graphic | 1024×500 opaque 8-bit sRGB PNG, no device image | Approved copy: “Your agents. In your pocket.” / “Your coding agents, from your phone.” |
| Eight phone screenshots | 1080×1920 opaque 8-bit sRGB PNG | Approved order: attention → terminal → changes → code → voice → runbook → plugins → onboarding. Authentic UI pixels are unchanged inside a consistent marketing frame. |
| Realtime capture | Current starfield UI in a healthy `Listening` state | Approved; contains no runtime error or private content. |

The final Play assets show authentic current-build UI, synthetic public data, no internal identifiers or private paths, and behavior proven against the frozen release source. Fable completed two full visual/policy review rounds and approved every screenshot, the feature graphic, and the store icon.

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
