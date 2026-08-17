# Public flip checklist

Run this when the owner decides to open the repository. Nothing here is
reversible once pushed; do the steps in order.

## Hygiene already landed (2026-08-15)

These were the first-hour on-ramp breakages. They are done in the working
tree; they do not make the repo public or publish npm.

- [x] `**/android/build/` gitignored; Gradle intermediates untracked
- [x] Stray root artifacts removed (`demo-change.ts`, `commands.json`, `herdr-api.schema.json`)
- [x] GitHub repository renamed to `muxr` (clone `umeranjum17/muxr`). npm publishes under `@trymuxr/cli`; the installed command remains `muxr`.
- [x] Public quickstart is npm-first: `npm install -g @trymuxr/cli`, then interactive `muxr`; source-clone setup is for contributors
- [x] OFL-1.1 text + NOTICE for Inter / JetBrains Mono / Bricolage Grotesque; Whisper + xterm in NOTICE
- [x] Issue/PR templates, Dependabot, docs index, plugin READMEs, capabilities docs
- [x] Contract plugin-bridge types match `plugin.*`; CI checks RequestMap + bundled `plugin check`
- [x] SECURITY.md states paired-device ⇒ shell; Runbook named as bundled remote shell

The repository and fresh public history are live. This checklist now tracks the current `v0.1.4` release candidate.

## Pre-flight (code state)

- [x] `node scripts/runSuite.mjs` green on plugin-platform working tree (27/27, 2026-08-16)
- [x] `node scripts/checkCorePurity.mjs` green — no cloud references in core
- [x] No paid/managed setup path is exposed; setup defaults to the self-hosted relay
- [x] LICENSE replaced with Apache-2.0 text; all `package.json` license fields → `Apache-2.0`
- [x] NOTICE intact: Happy + PI WEB attribution present; no Apache headers stamped on inherited third-party files
- [x] CONTRIBUTING.md, DCO.md, TRADEMARK.md, docs/SELF-HOSTING.md current
- [x] CI, Analyze, and CodeQL green through PR #26; the `v0.1.4` candidate passes the full local 29/29 suite, real installed ccusage smoke, Android JS bundle, and independent SHIP reviews (2026-08-17)

## History decision (choose one)

- [x] **Option A selected:** `umeranjum17/muxr` was created from a clean tree with fresh public history. The full prior history remains private in `muxr-private-archive`.
- [ ] **Option B not selected:** the private archive was not flipped public.

## Secrets sweep (either option)

- [x] `gitleaks` 8.30.1 clean on current history (341 commits, 20.28 MB scanned, 2026-08-16)
- [x] No env values, tokens, fingerprints, or customer data anywhere in tracked files (`checkNoSecrets.mjs`, enforced by `runSuite.mjs` in CI)
- [x] Optional provider credentials stay machine-local and are excluded from source/package artifacts

`gitleaks` remains a manual release/history gate because its executable is not vendored or version-pinned in this repository; CI uses the deterministic in-repo `checkNoSecrets.mjs` gate.

## Publish

- [x] Repo public; description, homepage, and topics set
- [x] Published `v0.1.1` with signed APK/AAB, `@trymuxr/cli` tarball, frozen source archive, complete demo, and verified `SHA256SUMS`
- [x] Published final `v0.1.3` Android/CLI/source/demo artifacts with verified checksums
- [x] Published and anonymously verified `@trymuxr/cli@0.1.3` through protected OIDC with provenance
- [ ] Publish the final `v0.1.4` artifacts after protected CI and scanner gates pass
- [ ] Publish and anonymously verify `@trymuxr/cli@0.1.4` through the protected OIDC workflow
- [x] Support policy posted in `README.md`: issues accepted, best-effort, no SLA

## After

- [ ] Watch first-week issues; free-tier support load starts now
- [x] Completed [the clean-room new-user smoke](NEW-USER-SMOKE.md) from public tag `v0.1.1` (fresh clone/build and 27/27 suite passed)
- [x] Installed and paired the `v0.1.2` release-candidate x86_64 APK on a clean emulator without the foreground-service crash
- [ ] Announce only after that full self-host flow passes
