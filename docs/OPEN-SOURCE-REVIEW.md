# Architecture & Open-Source Readiness Review

> Historical snapshot from before the public-core remediation. Resolved findings remain below as audit history; use [FLIP-CHECKLIST.md](FLIP-CHECKLIST.md) and the automated suite for current release status.

Date: 2026-08-15. Scope: full repo (`apps/`, `packages/`, `plugins/`, `scripts/`, `docs/`, `.github/`).
Method: six parallel deep-dive reviews (host/relay, mobile, plugin SDK, packages, security/legal, developer experience), cross-checked. Review only — no code was changed.

## Verdict

**Architecture: solid, unusually disciplined for pre-1.0. Open-source readiness: NOT ready to flip today — 6 blockers, all fixable in days, none requiring redesign.** `docs/FLIP-CHECKLIST.md` already tracks about half of them.

---

## Critical — open-source blockers

1. **~2,800 Gradle build files committed with author machine paths baked in.**
   `apps/mobile/modules/ssh-tunnel/android/build/` (1,366 tracked files, ~13 MB) and
   `apps/mobile/modules/voice-overlay/android/build/` (1,432 files, ~14 MB) embed
   `/home/umer/pockit/...`, `/home/umer/.gradle/caches/...`, and the Android SDK path
   (e.g. `ssh-tunnel/android/build/intermediates/incremental/lintVitalAnalyzeRelease/module.xml:3,9`).
   Root `.gitignore` ignores `dist/` but has no `build/` entry, so these regenerate into commits.
   Fix: `git rm -r --cached` both trees, add `**/android/build/` to `.gitignore`.

2. **Git history decision still open** (`docs/FLIP-CHECKLIST.md` "History decision" unchecked).
   332 commits containing pre-extraction cloud/commerce code (controlPlane, pricing docs).
   Recommendation: **Option A — fresh `muxr` repo, clean tree, single commit.**
   This also erases blocker #1's history residue. Option B requires a full
   `gitleaks detect --log-opts="--all"` and accepting old-commit exposure.

3. **SIL OFL fonts shipped without license text or attribution.**
   `apps/mobile/assets/fonts/`: Inter (3 weights), JetBrains Mono (3), Bricolage Grotesque (1) —
   all SIL Open Font License 1.1, which requires the license text to accompany redistribution.
   `LICENSES/` holds only Apache-2.0, MIT, Unlicense; NOTICE mentions no fonts.
   Same gap for the mobile artifact generally: the 59.7 MB Whisper model
   (`apps/mobile/sources/assets/models/ggml-base.en-q5_1.bin`, MIT) and the inlined minified
   xterm.js (`sources/terminal/terminalAssets.ts:8`) have no NOTICE coverage because
   `docs/license-inventory.md:26` scopes itself to the npm CLI artifact only.
   Fix: add `LICENSES/OFL-1.1.txt` + NOTICE entries; extend the inventory to the mobile artifact.

4. **Docs reference an npm package that does not exist yet.**
   README (`npx muxr setup`), `docs/SELF-HOSTING.md` (`npm install -g muxr && muxr self-host`),
   and `docs/npm-readme.md` all assume a published `muxr` package; the flip checklist admits
   `npm publish` is unchecked (and the referenced npm checklist lives in the private
   private hosted-service repo). The documented "primary" install path is dead for anyone but the author.

5. **Legal wording bug:** `CONTRIBUTING.md` ("Proposing changes") says contributions are
   distributed "under the repository's commercial license" — LICENSE is Apache-2.0.
   Every contributor agrees to that sentence; rewrite as "under the repository's
   Apache-2.0 license".

6. **Stray committed artifacts at repo root:**
   - `demo-change.ts` — runtime artifact the fake host writes into the session cwd
     (`apps/host/src/fakeSessionSource.ts:73,234`), accidentally committed. Delete + gitignore.
   - `commands.json` (255 B) — personal herdr quick-commands; nothing references it.
   - `herdr-api.schema.json` (245 KB) — generated herdr API schema dump (`protocol: 19`),
     zero references in code or docs, no regeneration instructions.
   Plus the first-command bug: README.md and CONTRIBUTING.md say
   `git clone https://github.com/umeranjum17/pockit.git` then `cd muxr` — the clone produces
   `pockit/`; `cd muxr` fails. Every new contributor hits this first.

---

## Correctness bugs worth fixing regardless of open-sourcing

1. **Replay resume breaks across host restarts — in both modes.**
   Cleartext mode: `let seq = 0` per process (`apps/host/src/relayLink.ts:58`).
   Hosted mode: `newV2SenderState()` starts seq at 0 with a fresh random epoch per process
   (`packages/crypto/src/index.ts:253-255`), but `v2EnvelopeSequence` extracts only the u64 seq,
   not the epoch (`index.ts:278-291`). The relay's replay filter is `header.seq > lastSeq`
   (`apps/relay/src/replay.ts:70-79`), so after a host restart every new frame has
   seq ≤ the client's `?lastSeq=` and is skipped. The epoch is authenticated inside the nonce
   but never mirrored into the routing header, so the relay cannot detect the epoch change.
   Resend-on-reconnect masks this for cumulative state only.

2. **Host silently drops outbound events while its relay link is down.**
   `apps/host/src/relayLink.ts:158` — `send()` returns early when the socket isn't OPEN; there is
   no outbound queue. On reconnect the host sends `machine.hello` + `resendCumulativeState()`
   (`apps/host/src/host.ts:88-104`), which heals attachments/changes/plugin-invalidation but NOT
   one-shot events: `session.removed`, `watch.settled`, `shell.*`, `status.update` emitted during
   an outage are gone forever (`herdrSessionSource.ts:1550-1566` resends only cumulative state).
   Sessions removed during an outage can persist as corpse rows on the phone — the exact bug
   `session.removed` was added to fix (`herdrSessionSource.ts:599-603`).

3. **The documented host/APK compatibility gate is stale and would fail if run.**
   `scripts/checkHostContract.mjs:26` requires `herdr.plugin.list` and `herdr.plugin.invoke`;
   neither exists in `RequestMap` (`packages/contract/src/requests.ts` — 41 keys, none named
   `herdr.plugin.*`) nor in the dispatcher (`apps/host/src/requests/createRequestDispatcher.ts`).
   `docs/HOST-CONTRACT-COMPATIBILITY.md` describes the bridge as `plugin.*` — doc, gate, and code
   all disagree. The gate is wired into neither `scripts/runSuite.mjs` nor CI, so the drift was
   invisible. Same class: `packages/contract/src/requests.ts:49-51` has a broken spliced comment
   in the file the gate parses.

4. **Synchronous full-file JSON rewrite per inbound message (hosted mode).**
   `HostV2Crypto.open()` snapshots every replay tracker and calls `onReplayChange` on every
   decrypted frame (`apps/host/src/hostedE2ee.ts:73-83`), and `main.ts:273-276` turns that into a
   synchronous `atomicWriteJson` of the whole replay state — one full file write per client
   keystroke. Same write-amplification on the relay: `OfflineBuffer.enqueue` rewrites the entire
   buffer file per message (`apps/relay/src/buffer.ts:67`) and `ReplayLog.record` likewise
   (`apps/relay/src/replay.ts:63`). Correct, but O(file) disk churn per routed envelope with no
   coalescing (`createPersistQueue` serializes but never merges).

5. **Unswept state:** attachment download tickets have a 5-minute TTL checked only on redemption
   (`attachmentDownloads.ts:89-95`); entries never downloaded grow unbounded. Relay keepalive
   pings have no pong tracking (`relay.ts:746-751`) so half-open sockets are never reaped. No
   per-message rate limit on authenticated WS peers (only connect-time, `relay.ts:586-590`) — a
   paired client can flood `JSON.parse`.

---

## Trust-boundary gaps

(The documented trust model is honest — these are its soft spots.)

1. **Preview listener ACL evaporates exactly when a proxy is in front.**
   `apps/relay/src/preview.ts:72-80,136`: the ephemeral TCP listener binds `0.0.0.0` and restricts
   to the WS peer's IP — unless the peer is loopback (`proxied`), in which case any address may
   connect, no token, no channel proof. The upshot is an unauthenticated port serving the user's
   dev server to the whole tailnet/LAN — and tailscale serve is the topology
   `docs/SELF-HOSTING.md` recommends. Mitigated by preview being refused when E2EE is on.

2. **Implicit same-box coupling between relay and host.**
   `apps/relay/src/relay.ts:289` — `MUXR_HOST_HTTP_URL ?? 'http://127.0.0.1:8793'`: the relay pipes
   bytes from the host's loopback attachment server. Two separate deployables with a hardcoded
   loopback contract; breaks if relay and host are ever on different machines, and the env var is
   undocumented in SELF-HOSTING.md. Dev-fixture-only path (410 with E2EE on).

3. **Paired-device ⇒ full-user-shell equivalence is under-signposted.**
   Any paired device can run arbitrary shell (`session.shell` → `/bin/sh -c`,
   `herdrSessionSource.ts:1553-1576`; `machine.shell`, `requests/runMachineShell.ts`; full
   `herdr.cli` passthrough, `requests/runHerdrCli.ts`) and read any file (`readFile`,
   `herdrSessionSource.ts:1581-1595`). This IS the product, and browser grants are correctly
   fenced read-only (`createRequestDispatcher.ts:178-197`) — but SECURITY.md does not state the
   equivalence. External security reviewers will find it before it is documented.

4. **`runbook` plugin is a bundled remote shell.** Its write-mode RPC is a general shell executor
   (`plugins/runbook/rpc.mjs:33-38` — `execSync(found.run)`). Consistent with the documented
   "unsandboxed as your computer user" model, but it should be named explicitly as the sharpest
   bundled edge. Also: `runbook/rpc.mjs:8` falls back to `MUXR_PLUGIN_STATE_DIR ?? '.'`, silently
   writing `commands.json` into the host's cwd if the env var is missing.

5. **Plugin RPC containment is good but leaky by design.** Strengths: env scrubbed to
   PATH/HOME/MUXR_HOME + three MUXR_* vars, 30 s timeout, stdout capped at 64 KiB with
   reject-not-truncate, stderr ring-buffered, global semaphore of 4
   (`herdrSessionSource.ts:220,964-1006`). Leaks: a plugin can `spawn(detached).unref()` children
   that outlive every cap (`plugins/run-server/start.mjs:28-34` does exactly this); `cwd` is the
   host's cwd so plugins act machine-wide.

6. **Legacy v1 codec accepts cleartext when enabled.** `decryptPayload` returns input untouched
   when the `e2ee:v1:` tag is absent (`packages/crypto/src/index.ts:89-91`), so
   `createPayloadCodec(key).decode` passes cleartext silently — a downgrade surface if a relay
   strips encryption in local mode. v2 fails closed correctly (`openV2`, index.ts:317-360).
   Dev-fixture-only today; schedule v1 + `MUXR_E2EE_SHARED_KEY` removal post-1.0.

---

## Structural / architecture debt

1. **`packages/wire` is ~80% dead legacy with a name collision.**
   Only two import sites repo-wide (`apps/mobile/sources/sync/apiTypes.ts:2-8`,
   `sources/sync/typesRaw.ts:3`); `sessionProtocol.ts` header reads "UNDER REVIEW — NEEDS MORE
   CAREFUL DESIGN … Do not add new consumers"; `voice.ts` ships ElevenLabs quota schemas and
   `rigMetadata.ts`/`messageMeta.ts` reference a third-party client ("Rig") — verify NOTICE covers
   this inherited lineage. The package is outside the root `tsc --build` graph
   (`tsconfig.json:3-17`), has weaker tsconfig flags than the monorepo base (a second convention),
   and the REAL wire format lives in `packages/contract/src/wire.ts` — two packages named like
   the protocol. Best outcome: move the two used exports into `apps/mobile`, delete the package.
   Second best: rename to `@muxr/sync-schemas` and wire it into the build.

2. **No schema validation on the active wire path.** `decodePayload` is an unchecked
   `JSON.parse(payload) as T` cast (`packages/contract/src/wire.ts:96-99`); inbound ClientFrames
   are trusted to match the type. Defensible today (v2 envelope + dispatcher guards unknown types,
   `createRequestDispatcher.ts:225-228`), but the repo ships zod schemas validating a DIFFERENT,
   legacy protocol while the active contract has none. The envelope also has no version field —
   versioning = additive request types + structured `host-contract-mismatch` + a manual release
   gate (currently broken). Add a compile-time equality guard between `RoutingChannel`
   (`contract/src/wire.ts:25`) and `V2Channel` (`crypto/src/index.ts:133`), currently kept in sync
   by a comment only.

3. **Hand-rolled KDF in crypto.** `deriveV2Key` (`packages/crypto/src/index.ts:246-251`) is
   `SHA-512(label || root)[0:32]` — not HKDF, not a keyed PRF. Practical risk is low with 32-byte
   high-entropy roots, but it is exactly the custom construction reviewers flag. Swap for
   HKDF-SHA-256 or libsodium KDF (already a mobile dep via `@more-tech/react-native-libsodium`).

4. **`startRelay` is a ~650-line closure** (`apps/relay/src/relay.ts:112-759`) interleaving
   mint-secret management, rate limiting, static web serving with CSP, pairing REST, ticket
   issuance, grant rotation, device revocation, WS auth, terminal/preview plumbing, and mDNS.
   Works and is well-commented, but the self-host HTTP API (~lines 327-560) is a
   controllers-worth of routing inlined into one function — the natural extraction seam if the
   project wants outside contributors.

5. **Mobile dead code:**
   - `sources/sync/apiSocket.ts` — 271-line socket.io `ApiSocket` class; nothing imports the
     instance (only two helper functions are used). The real transport is
     `sources/client/muxrClient.ts` (raw WebSocket + `@muxr/contract`). `socket.io-client` in
     `apps/mobile/package.json` is used only by the dead class. Delete both.
   - Vestigial Happy-era friends/social layer: `sources/sync/apiFriends.ts` (REST endpoints the
     OSS relay does not implement), `friendTypes.ts`, `app/(app)/user/[id].tsx` (unreachable —
     `UserSearchResult.tsx` has zero importers), friend selectors in `storage.ts:805-815`.
   - Dead config chain: `EXPO_PUBLIC_ELEVENLABS_AGENT_ID` → `app.config.js:41` →
     `AppConfig.elevenLabsAgentId` — never consumed.

6. **Giant views with business logic:** `sources/components/HomeDock.tsx` (1,119 lines) owns the
   composer, settings menu, attachment strip, agent/environment pickers, and calls
   `listWorktrees`/`isMachineOnline`/`resolveAbsolutePath` directly. Also large:
   `MarkdownView.tsx` 665, `HerdView.tsx` 638, `TerminalScreen.tsx` 609, `machine/[id].tsx` 600.

7. **Committed `android/` prebuild pinned to the author's preview identity.**
   `apps/mobile/android/app/build.gradle:90-92` hardcodes `app.muxr.local.preview`; contributors
   changing `MUXR_APP_ID_BASE` must re-run prebuild or the committed dir silently wins.
   NATIVE-BUILD.md does not document this interaction.

8. **Three undocumented deployment mechanisms, no canonical one.** `Dockerfile` (clean relay-only
   multi-stage build, non-root — the good one), `docker-compose.yml` (thin wrapper),
   `nixpacks.toml` (Railway config whose comment describes installing the full workspace incl.
   mobile — smells like a leftover pre-split monolith deploy, contradicting the Dockerfile's
   relay-only scope). Zero references to any of the three in README/docs/CI. A self-hoster cannot
   discover that `docker compose up` exists. Pick one (recommend Dockerfile), document it, delete
   or justify the rest.

9. **The open-core boundary leaks through `scripts/`.** `scripts/cloud-enroll.mjs` is Tier-3
   cloud control-plane enrollment (`MUXR_CONTROL_URL`, `MUXR_BOOTSTRAP_TOKEN`) shipped in the OSS
   repo and bundled into the npm package (`scripts/pack.mjs:112`). `checkCorePurity.mjs` only
   greps `apps/relay/src apps/host/src packages/*/src`, so scripts/ escapes the purity gate.
   Either document it as intentional or move it out.

10. **scripts/ sprawl: 38 files, ~5,768 lines, one `--help` between them** (`cli.mjs` only).
    Orphaned (zero references): `serveWebExport.mjs`, `genBrand.sh`. Manual-only, never run by CI:
    `checkHostContract.mjs` (see Correctness #3), `packageAudit.mjs`. Setup logic is split across
    six overlapping files (`cli.mjs`, `local-setup.mjs` at 1,562 lines, `setup-wizard.mjs`,
    `setup-ui.mjs`, `host-up.mjs`, `up.mjs`) knowable only by reading cli.mjs.

11. **Error-handling inconsistency across plugin RPC backends.** `example-ui/rpc.mjs:5-8` guards
    `JSON.parse(MUXR_PLUGIN_INPUT)`; `ports/rpc.mjs`, `git-history/rpc.mjs`, `runbook/rpc.mjs`,
    `vitals`, `usage-status/rpc.mjs` parse unguarded — malformed input surfaces a raw stack trace
    instead of a clean message.

12. **Doc/comment drift samples:**
    - `plugins/example-ui/rpc.mjs:31-32` tells authors to persist under `HERDR_PLUGIN_STATE_DIR`/
      `HERDR_PLUGIN_CONTEXT_JSON` — RPC children actually get `MUXR_PLUGIN_*` vars
      (`herdrSessionSource.ts:973-978`). `muxr plugin create` copies example-ui verbatim, so every
      new plugin starts from the lie. It also uses fixed-index bindings while PLUGINS.md presents
      `repeat` as the way to render lists.
    - `skills/` vs `docs/skills/` are tracked duplicates with drift already present; no doc says
      which is canonical.
    - `docs/DEMO.md` prescribes a manual three-terminal stack contradicting README's `yarn up`.
    - `docs/changes-pill-plan.md` is a stale working plan at docs/ top level; references
      `/home/umer/muxr`.
    - `docs/SELF-HOSTING.md` names the email seam `TransactionalEmail`; code calls it
      `NotificationEmail` (`apps/relay/src/email.ts:9`). SELF-HOSTING covers maybe half the
      `MUXR_*` knobs; there is no single env-var reference.
    - README says "Linux host"; SELF-HOSTING says "Linux, macOS, WSL" (`local-setup.mjs:534` has a
      darwin branch — README is stale).
    - README layout lists `deploy  TLS proxy` — no `deploy/` directory exists.
    - `docs/license-inventory.md` claims the npm artifact excludes relay source and `web-push` —
      false (`pack.mjs:56-57` bundles relay.js; `dist-npm/package.json` declares web-push).

13. **Pack pipeline is solid, reproducibility is partial.** `scripts/pack.mjs` bundles with
    esbuild, rewrites the plugin validator's `@muxr/contract` import with a tripwire, verifies web
    export freshness, fails on copyleft/unknown licenses. Gaps: artifact varies with
    `MUXR_PACKAGE_CONTROL_URL` (no single reproducible tarball), no npm-publish automation or
    provenance attestation, packed `dependencies` use caret ranges with no lockfile shipped — two
    installs a week apart can resolve different `ws`/`web-push` minors. (The plugin-install path
    `scripts/package.mjs` is much stricter — exact versions, `--ignore-scripts`, provenance — than
    the pipeline that ships muxr itself.)

14. **Packages can't build themselves.** `@muxr/contract` and `@muxr/crypto` have no `scripts`
    blocks, no `description`/`repository`/`files`, and sit at `0.0.0` — buildable only via root
    `tsc --build`. Fine if workspace-internal forever; impossible to publish as-is. Self-checks
    (`crypto/src/selfCheck.ts`, `contract/src/selfCheck.ts`) compile into `dist/` and would ship
    in an `npm publish` without a `files` whitelist. No package-level READMEs except
    `packages/wire`. `packages/crypto/tsconfig.json` adds `"DOM"` lib for `atob`/`btoa`, leaking
    DOM globals into a Node/RN library.

15. **Accessibility is partial (mobile).** 36 of 135 `.tsx` files reference
    `accessibilityLabel`/`accessibilityRole`; icon-only `Pressable`s throughout HomeDock mostly
    lack labels; no font-scaling or screen-reader passes evident.

---

## What's missing (by audience)

### For the flip itself
- OFL-1.1 license text + NOTICE entries for the three font families; extend license inventory to
  the mobile artifact (Whisper model, xterm.js).
- Purge `**/android/build/` + `.gitignore` entry; delete `demo-change.ts`, `commands.json`,
  `herdr-api.schema.json` (or move to docs/ with regeneration notes).
- History decision (recommend Option A fresh repo); full `gitleaks detect --log-opts="--all"`.
- Repo rename/repoint: pockit→muxr URLs in README, CONTRIBUTING, and `dist-npm/package.json`.
- Fix the six doc contradictions + CONTRIBUTING "commercial license" line.
- First GitHub Release (APK + SHA256), npm publish, support policy — all already in
  FLIP-CHECKLIST, still open.

### For contributors
- `.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md` (CONTRIBUTING asks for verification output
  but gives no template), Dependabot/Renovate config (none today — notable for a remote-shell
  product; no `yarn audit` in CI either), DCO sign-off step in CONTRIBUTING.md, root CHANGELOG.
- A canonical deployment doc (Docker) and a scripts/ "what runs what" table.
- `docs/README.md` index — docs/ is a flat pile; only `decisions/` has an index.
- Package-level READMEs for `apps/host`, `apps/relay`, `packages/contract`, `packages/crypto`.

### For mobile builders
- Keystore setup steps for `eas build --local` (`credentials.json`) — NATIVE-BUILD.md lists the
  requirement but never says how.
- "Expo Go will not work" statement (custom native modules + patch-package).
- Document the undocumented env vars: `EXPO_PUBLIC_MUXR_E2EE_KEY`
  (`connectionSettings.ts:38`), `EXPO_PUBLIC_DEV_TOKEN`/`EXPO_PUBLIC_DEV_SECRET` dev auto-login
  (`app/_layout.tsx:179-186`), `EXPO_PUBLIC_SERVER_URL` (`appConfig.ts:73`).
- iOS story: both local native modules (`voice-overlay`, `ssh-tunnel`) are Android-only Kotlin —
  an iOS build compiles but silently lacks voice-overlay/SSH. Undocumented.
- The in-app SSH tunnel feature (TOFU host-key pinning, `modules/ssh-tunnel/`, `sshForward.ts`,
  `settings/ssh.tsx`) appears in no doc.
- One-paragraph README per patch in `patches/` — the `react-native-live-audio-stream` patch
  rewrites an effectively unmaintained upstream's `init`/`start`/`stop` signatures; a version bump
  breaks it loudly.
- Consider download-at-build (checksum already exists in `verifyNativePatches.mjs`) instead of the
  59.7 MB committed Whisper binary; `.git` is 132 MB.

### For plugin authors
- Document the `capabilities` manifest field — load-bearing (parsed in
  `packages/contract/src/manifest.ts:230-235,263,372-374`, consumed by the app for feature
  discovery, `startDevServer.ts:16`) and never mentioned in 370 lines of PLUGINS.md. Also the
  `screen-button` type for `session.header.trailing`.
- A published typed SDK (`@muxr/plugin-contract` from `packages/contract/src/plugins.ts`) and/or a
  JSON Schema for `muxr-ui.json` — today authors get validation only by running
  `muxr plugin check` and reading thrown strings.
- CI gate running `muxr plugin check` over all 17 bundled plugins (7 can ship broken undetected;
  `checkPackageSmoke.mjs:39-48` link-tests only a hardcoded 10). Wire `checkHostContract.mjs` into
  CI/runSuite too.
- Per-plugin READMEs for file-viewer, git-history, ports, runbook, vitals (the repo's own rule);
  fix `plugins/README.md` (lists 10 of 17 plugins; links nonexistent `docs/EXTENSIONS.md`;
  misdescribes example-ui).
- A published compatibility policy for when `MUXR_UI_VERSION` will bump.

---

## Strengths — do not regress these

- **Security posture is enforced in code, not just docs:** one-use 60 s WS tickets (24 random
  bytes, SHA-256-hashed at rest, serialized claim queue, `apps/relay/src/selfhostTickets.ts`);
  strict auth by default with a loopback-only dev fixture that refuses non-loopback binds
  (`config.ts:57-62,83-87`); opaque-v2-only framing enforced by the relay when E2EE is on
  (`relay.ts:663,706`); pairing state fails closed on corruption and never auto-restores a backup
  that could resurrect revoked credentials (`selfhostPairing.ts:62-72`); 0600/0700 credential
  storage everywhere; rate-limited HTTP/WS with trust-proxy opt-in; Origin allowlist; HSTS.
- **`packages/crypto` is genuinely careful:** tweetnacl standard primitives, deterministic
  epoch‖seq nonces, context authenticated inside the seal, bounded fail-closed replay tracker,
  restart-safe snapshots, signed+sealed device grants — all exercised by a runnable adversarial
  self-check. Fails closed everywhere.
- **Clean layering, grep-verified:** zero deep imports into package internals, zero package→app
  dependencies; `@muxr/contract` is a zero-dependency single source of truth consumed by host,
  relay, mobile, CLI, and the release gate.
- **Single manifest parser shared by host/app/CLI** (`packages/contract/src/manifest.ts`) —
  plugin validation cannot drift between author tooling and runtime. Bounded RPC runtime
  (scrubbed env, byte/time/concurrency caps, idempotency-fenced writes).
- **Docs-to-code fidelity is high:** every "Facts worth knowing" claim in ARCHITECTURE.md
  (one-request-per-socket, filtered-subscription batch rejection, `control` resizing the real
  PTY, first-frame buffering) is implemented exactly where the doc says.
- **Failure-contains-failure discipline:** unspawnable herdr, EPIPE on stdin, busy download port,
  corrupt state files — all degrade locally instead of killing the host.
- **Mobile secret handling is exemplary:** SecureStore + per-machine E2EE grant index; OpenAI
  long-lived key never touches the phone (host plugin mints short-lived realtime tokens); legacy
  MMKV key captured once and purged; analytics stubbed to a null tracker by design; hosted builds
  scrub `EXPO_PUBLIC_MUXR_TOKEN`/`E2EE_KEY`. The AGENTS.md microphone-FGS invariant is enforced in
  code (`realtime/realtimeSessionState.ts` gates `startRealtimeSession` on `startVoiceService()`), not just
  documented.
- **`scripts/runSuite.mjs` + single CI job:** one gate, every check runs even after failure,
  herdr-dependent checks degrade gracefully, env scrubbing against inherited deployment
  credentials; `checkNoSecrets.mjs` + `.gitleaks.toml` in CI; `checkCorePurity.mjs` enforces the
  open-core boundary mechanically.
- **Legal scaffolding more complete than most projects at this stage:** Apache-2.0 LICENSE,
  NOTICE with Happy/pi-web attribution, LICENSES/, license-inventory, DCO, TRADEMARK, GOVERNANCE,
  CODE_OF_CONDUCT, SECURITY.md with an honest scope.
- **`docs/FLIP-CHECKLIST.md` itself** — an honest, ordered launch gate; most of this review's
  blockers were already self-identified there.
- **`docs/decisions/` ADRs with an index** — the one docs subfolder with real structure.

---

## Suggested order of operations

1. Purge `android/build/` trees + `.gitignore` entry; delete `demo-change.ts`, `commands.json`,
   `herdr-api.schema.json`.
2. Fresh-repo flip (Option A) with OFL fonts + NOTICE fixed in the clean tree.
3. Fix the six doc contradictions + CONTRIBUTING license line (one sitting).
4. Fix the replay-restart seq/epoch bug and the stale contract gate (wire it into CI) **before**
   announcing — those two are real bugs users will hit.
5. First public week: issue/PR templates, Dependabot, `capabilities` docs, `packages/wire`
   deletion, canonical deployment doc, per-plugin READMEs.

## Review-verified non-issues

(Checked and cleared during the review — listed so they are not re-litigated.)

- No committed secrets found (bounded scan of all 332 commits for key shapes; only a false
  positive `TextInput` placeholder). `checkNoSecrets.mjs` covers 1,159 tracked files.
- `dist-npm/` is NOT committed — it is gitignored local pack output (`.gitignore:23`).
- `.pi-subagents/` is correctly untracked.
- License fields are uniformly Apache-2.0 across package.json files; root LICENSE present.
- `preview.ts:149` pid-in-shell-string is typed `number | undefined` and guarded — not injectable.
- Mic foreground-service invariant, offline read-only sync model, and hosted-mode credential
  scrubbing are all enforced in code.
- Test-suite minimalism (164 flow tests) is a deliberate repo decision per AGENTS.md — not a
  finding.
