# Distribution runway

What stands between the current release and the two stores, split by who must act.
Everything under "agent can do" is prepared; everything under "owner must do" is
legally or cryptographically impossible to delegate.

## Google Play

### Owner must do (cannot be delegated)

1. **Create the Play Console account**: your Google account, $25 one-time fee,
   and identity verification (government ID, address). ~10 minutes plus
   Google's verification latency.
2. **Create the app entry** named `muxr` with package `com.trymuxr.app`
   (immutable after first upload).
3. **Accept the legal declarations** (content rating, data safety, target
   audience). These are attestations under your name; the draft answers are
   already in `docs/PLAY-STORE-PLAN.md` §4–5, you review and submit them.
4. **Create the Play API service-account key** if you want automated uploads.
   Google Cloud no longer allows service-account key creation in
   non-interactive mode, which is exactly where the last attempt stopped.
   Alternative that needs no key at all: drag the AAB into the Console web UI.
5. **Recruit 12 testers for 14 days** if your Play Console account is a
   personal account created after November 13, 2023. Production access is
   gated on this closed test. Friends, the r/PiCodingAgent thread, and the
   herdr community count; they need Gmail addresses and opted-in Androids.
6. **Press "send for review"** and answer any reviewer questions.

### Agent can do (once the account exists)

- Build the signed AAB locally from the clean tag (`eas build --local`, no
  cloud credits — this is already the release process).
- Prepare and maintain listing copy, screenshots, feature graphic, FGS
  declaration video, and Data safety/IARC drafts (assets ready in
  `docs/play/store-assets/`).
- Configure `assetlinks.json` with the Play app-signing fingerprint once Play
  exposes it.
- Run pre-submission verification (suite, clean-room smoke, bundletool splits,
  App Links, upgrade path).
- Upload via web UI walkthrough or `eas submit` once a service-account key
  exists.

**Realistic timeline after you create the account:** internal testing same
day; closed test 14 days (mandatory wait); production review a few days after
that. Budget ~3 weeks, almost all of it waiting.

## iOS

### Owner must do

1. **Enroll in the Apple Developer Program** ($99/year, your Apple ID, identity
   verification).
2. **Decide how iOS gets built without a Mac in this house.** Options:
   - **EAS Build (cloud)** — the realistic path. Builds and signs iOS from
     this Linux machine, but spends EAS credits and holds Apple credentials.
     This contradicts the local-only Android rule and needs your explicit ok.
   - **Buy/borrow a Mac** — local Xcode builds, no credits, full control.
   - **GitHub Actions macOS runner** — free-ish for public repos, still needs
     Apple credentials uploaded as CI secrets.
3. **Create the App Store Connect app** and accept Apple's agreements.
4. **Test on a physical iPhone** you own before any TestFlight link goes out.

### Agent can do (in order, once 1–2 exist)

**Done already (2026-08-18):** the production iOS project is generated and committed at `apps/mobile/ios` — `com.trymuxr.app`, audio + remote-notification background modes, `applinks:trymuxr.com`, camera/mic usage descriptions. The Android-only modules degrade gracefully in JS. What remains needs the account and a build machine:

1. First compile on the chosen path (Xcode/EAS/macOS runner); fix whatever surfaces.
2. Stub or port the three Android-only native modules: `voice-overlay`,
   `ssh-tunnel`, `plugin-shortcuts`. Minimum viable: compile-time stubs so the
   app ships without voice/SSH/shortcuts; full ports later.
3. Fix the live AASA file: set `MUXR_APPLE_TEAM_ID` on the site service to the real Team ID from developer.apple.com → Membership (it currently still answers `STAGING000`).
4. TestFlight external beta (light review, no full App Store launch required).
5. App Store listing: privacy nutrition labels, iPhone screenshots, review.

**Honest scope:** iOS native is a week-plus of focused work after the accounts
exist, not an afternoon. The read-only web client is the iOS answer until then
— it runs in Safari today, and the README already says so.

## What I need from you, as one short list

1. Google Play Console account ($25) → tell me when it exists.
2. Decide: web-UI AAB upload or service-account key for automation.
3. Apple Developer enrollment ($99) → only when you want iOS native.
4. Pick the iOS build machine story (EAS cloud vs Mac vs CI runner).
5. 12 tester Gmail addresses when the closed track opens.
