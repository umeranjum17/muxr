# Public flip checklist

Run this when the owner decides to open the repository. Nothing here is
reversible once pushed; do the steps in order.

## Hygiene already landed (2026-08-15)

These were the first-hour on-ramp breakages. They are done in the working
tree; they do not make the repo public or publish npm.

- [x] `**/android/build/` gitignored; Gradle intermediates untracked
- [x] Stray root artifacts removed (`demo-change.ts`, `commands.json`, `herdr-api.schema.json`)
- [x] GitHub repository renamed to `muxr` (clone `umeranjum17/muxr`). npm package name stays `muxr`.
- [x] Setup path is clone + `node scripts/cli.mjs`; npm mentioned as "when published"
- [x] OFL-1.1 text + NOTICE for Inter / JetBrains Mono / Bricolage Grotesque; Whisper + xterm in NOTICE
- [x] Issue/PR templates, Dependabot, docs index, plugin READMEs, capabilities docs
- [x] Contract plugin-bridge types match `plugin.*`; CI checks RequestMap + bundled `plugin check`
- [x] SECURITY.md states paired-device ⇒ shell; Runbook named as bundled remote shell

Still not done here on purpose: repo public, `npm publish`, history rewrite
(Option A), first GitHub Release.

## Pre-flight (code state)

- [x] `node scripts/runSuite.mjs` green on plugin-platform working tree (27/27, 2026-08-16)
- [x] `node scripts/checkCorePurity.mjs` green — no cloud references in core
- [x] No paid/managed setup path is exposed; setup defaults to the self-hosted relay
- [x] LICENSE replaced with Apache-2.0 text; all `package.json` license fields → `Apache-2.0`
- [x] NOTICE intact: Happy + PI WEB attribution present; no Apache headers stamped on inherited third-party files
- [x] CONTRIBUTING.md, DCO.md, TRADEMARK.md, docs/SELF-HOSTING.md current
- [ ] CI workflow green on the final public candidate commit

## History decision (choose one)

- [ ] **Option A (default): fresh public repo.** Create `muxr` as a NEW repo,
      copy the clean tree, `git init`, single initial commit. Zero history
      exposure. The previous GitHub name (pockit) stays private as the archive if you keep it.
- [ ] **Option B: same repo flipped.** Only after `gitleaks detect --source . --log-opts="--all"`
      is clean AND the owner accepts that pre-extraction cloud code
      (controlPlane/commerce, pricing docs) is visible in old commits.

## Secrets sweep (either option)

- [ ] `gitleaks detect` clean on current tree
- [x] No env values, tokens, fingerprints, or customer data anywhere in tracked files (`checkNoSecrets.mjs`, enforced by `runSuite.mjs` in CI)
- [x] Optional provider credentials stay machine-local and are excluded from source/package artifacts

`gitleaks` remains a manual release/history gate because its executable is not vendored or version-pinned in this repository; CI uses the deterministic in-repo `checkNoSecrets.mjs` gate.

## Publish

- [ ] Repo public (or fresh repo created), description + topics set
- [ ] First GitHub Release: APK + SHA256 checksum
- [ ] Complete the npm release checklist and publish the CLI package
- [ ] Support policy posted: issues accepted, no SLA

## After

- [ ] Watch first-week issues; free-tier support load starts now
- [ ] Complete [the clean-room new-user smoke](NEW-USER-SMOKE.md) from the public tag and release artifacts
- [ ] Announce only after that full self-host flow passes
