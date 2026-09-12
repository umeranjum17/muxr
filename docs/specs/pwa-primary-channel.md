---
title: PWA-primary final execution contract
slug: pwa-primary-channel
status: in-progress
created: 2026-09-11
updated: 2026-09-12
owner: umer
links:
  - ../user/install.md
  - ../../plugins/control/herdr-plugin.toml
  - ../../scripts/setup/domain/configSchema.mjs
---

# PWA-primary final execution contract

Status: **FROZEN FOR EXECUTION**  
Date: 2026-09-11  
Product authority: owner’s PWA-first / Herdr-plugin-first vision  
Planning inputs:

- `astra-pwa-forensic-gap-audit.md` — systems/security/delivery, maximum effort
- `fable-pwa-forensic-gap-audit.md` — product/UX/acquisition, maximum effort
- Current pockit candidate `5d1e81914dc56a6b957ded3ecd9fd894b6d1d1d2`
- Current website candidate `cad05dacc2c87772129b6f8fb57e4b58f9a90694`, locked to stale pockit `a3113fda`
- Current public getmoshi.app, ColliePWA, Codie Coder, Happy, Claude Code Remote Control, Cursor Web/Mobile, Tailscale, RustDesk, Terraform/mise, and official Herdr plugin/marketplace docs

This contract replaces every older PWA-primary task list, phase list, open-ended “Moshi polish” instruction, and advisor backlog. A writer may not invent product decisions or add scope. A final reviewer may block only a numbered contract failure, P0/P1 correctness issue, security regression, or data-loss risk.

## 1. Product definition

muxr is acquired and understood in this order:

1. A visitor opens `trymuxr.com`.
2. They try a credential-free interactive demo built from production UI and transport seams.
3. They choose **Connect your computer**.
4. A Herdr user installs the muxr control plugin from its exact GitHub source and opens its Setup pane. npm/CLI is shown only as the “without Herdr / advanced” fallback.
5. Setup recommends one browser-capable HTTPS route, shows one inspectable plan, then applies it.
6. The user opens muxr from their own host origin, optionally installs that PWA, and consents to a scoped browser grant.
7. They perform one useful action against a real Herdr session.
8. Notifications, realtime voice, extensions, advanced networking, and native Android/iOS are introduced only when relevant.

The public marketing origin remains a credential-free demo. It does not store host grants, serve pairing/restore routes, or become a universal credential-bearing PWA. The installable daily PWA is served from the user’s authorized HTTPS host origin. This preserves the existing trust boundary.

Native apps are optional upgrades for native-only capabilities such as background microphone ownership, OS integrations, multicast discovery, and store-managed installation. They are not prerequisites for the primary journey.

## 2. Fixed terminology

- **computer**: the user-owned machine running Herdr and muxr; use this in beginner tasks.
- **host**: the muxr process on that computer; define before using.
- **relay**: routes encrypted traffic; it cannot read E2EE payloads.
- **browser app / PWA**: the primary daily client served from the user’s host origin.
- **native app**: optional Android/iOS client.
- **Herdr plugin**: installs and operates muxr from Herdr.
- **muxr plugin**: extends muxr with a workflow or surface.
- **pairing link**: one-use invitation expiring in two minutes.
- **browser access**: Control or View-only grant lasting eight hours, or explicit Personal Control lasting 30 days.
- **machine enrollment**: separate advanced shared-relay invitation expiring in five minutes.

Do not use phone, host, machine, computer, pairing, enrollment, claim, grant, view-only, read-only, and observe as interchangeable marketing words.

## 3. Non-negotiable security and reliability invariants

1. E2EE remains mandatory for session, terminal, attachment, plugin stream, preview, and takeover payloads.
2. Relay never receives plaintext keys, prompts, terminal content, or provider credentials.
3. Browser authority is explicit by role and expiry; installed display mode grants no additional authority.
4. Revocation closes sockets, invalidates tickets, and rotates affected ingress/data keys.
5. Preview content never gains trusted PWA-origin storage, opener, top-navigation, cookies, or same-origin authority.
6. One controller owns takeover at a time; failed/stale attempts release ownership.
7. Provider policy, credentials, account details, and model selection stay host/plugin-owned. Clients receive generic configured/unavailable/permission/retry states.
8. Native foreground microphone service starts before native microphone ownership.
9. Secret-bearing invalid config values, URLs, lines, provider failures, SDP, tokens, and invitations are never echoed in logs, JSON receipts, screenshots, or errors.
10. User drafts, attachments, wrapping keys, grants, and pending commands survive concurrency/retry without silent loss or duplication.

## 4. Research-backed onboarding decisions

Adopt:

- getmoshi.app’s hierarchy: explain the product, show value, disclose a small core feature set, defer optional integrations, and end every page with a concrete next step.
- ColliePWA’s demo-first and Herdr-first shape, exact version/source disclosure, and docs/skill derived from repository truth.
- Claude Remote Control/Happy’s URL-or-QR handoff, reason-specific reconnect language, and permission prompts only at first relevance.
- Herdr’s real install preview, GitHub source syntax, one-shot startup semantics, declarative panes, injected runtime paths, and marketplace topic/default-branch discovery model.
- Tailscale/Terraform/mise’s inspect → plan → apply → verify flow with provenance and machine-readable results.

Reject for this release:

- a credential-bearing hosted marketing PWA;
- a new community relay/tunnel product;
- account-bound acquisition;
- replacing the interactive demo with video;
- a new configuration language, docs framework, CMS, or daemon supervisor;
- copying Moshi’s brand, SSH architecture, pricing, or aesthetic details;
- open-ended polish after measurable interaction/accessibility floors pass.

## 5. Known blockers to close

### S1 — Config secret echo

Reject URL userinfo/query/fragment and malformed secret-bearing config before output. Errors name the key and violated rule, never the submitted value. Add fake-canary tests across text and JSON output.

### S2 — Browser wrapping-key race

Make IndexedDB wrapping-key creation atomic across independent tabs/module realms. Every contender must use the winning persisted key. Add one real-browser concurrent-first-write/reload flow test.

### S3 — Preview top-level isolation

Enforce isolation at the service-worker/bridge response boundary, not only by hiding an Open button. Normal sandboxed iframe rendering must continue; direct/top-level navigation, opener access, and trusted-origin storage must fail.

### S4 — Herdr runtime update record

A valid `muxr update` must atomically refresh the plugin runtime identity. A failed update preserves the prior working runtime. Replace every invalid `herdr plugin install muxr` recovery string with the supported full source. Verify upgrade and rollback across two actual package versions.

### S5 — Candidate identity and integration

Integrate current `origin/main` before final behavior work. Preserve current main dependency/release changes; do not revert them to the branch’s older 0.1.25 metadata. Candidate gates must identify the exact CLI package/tarball, plugin source, loaded plugin roots, PWA export, pockit SHA, website SHA, and website source lock—not semver alone.

### S6 — Browser-first route and Safari behavior

Fresh setup recommends a browser-capable HTTPS route and never silently reports success by demoting the user to native. If no browser-capable route is ready, state the exact prerequisite and preserve the setup plan. LAN/native remains an explicit advanced alternative. Safari may pair in the current tab without installing; installing later explains that a fresh grant is needed in the separate installed-app storage partition.

### S7 — Provider-neutral client

Move provider selection, credentials, account/refusal detail, and model configuration to host/plugin operations. Browser/native clients show only generic readiness, permission, retry, transcript/audio, and a host-setup direction. Existing realtime provider adapters remain.

## 6. Herdr plugin product contract

### Public path

Primary instructions:

```text
herdr plugin install umeranjum17/muxr/plugins/control --ref <released-ref>
herdr plugin pane open --plugin muxr.control --entrypoint setup
```

The default branch may omit `--ref` only after the merged source and published CLI are known to match. npm installation remains the documented fallback for people without Herdr.

### Marketplace and manifest

- Public repository has the `herdr-plugin` GitHub topic.
- `plugins/control/herdr-plugin.toml` on the default branch is installable.
- Control plugin name/description says **Start here** and accurately discloses that its build installs a verified npm CLI as the current user, without sudo.
- Bundled internal plugin descriptions say **Installed by muxr — do not install directly**, so the multi-manifest marketplace card has a clear entrypoint.
- Installation preview remains human-visible; automation uses `--yes` only after explicit source trust.

### Lifecycle

- Build resolves npm `latest` to one exact version, verifies it, records it owner-only, and reports it. `MUXR_CLI_PIN` remains the exact candidate/test override.
- Runtime state remains under `~/.muxr`; no state or credential is written into Herdr’s replaceable plugin checkout.
- Startup hook is one-shot and only kicks an already configured OS-managed service. It does not pretend Herdr supervises the daemon.
- The install/build completion prints the exact Setup-pane command.
- Setup, Pair browser, Devices, Doctor, Service, shared relay, add-ons, and host voice configuration are reachable through declared panes/actions backed by the same CLI operations.
- Default Pair action is browser Control; View-only, Personal Control, and native pairing remain explicit alternatives.
- Invoking `HERDR_BIN_PATH`/socket wins when multiple Herdr instances exist.
- GitHub uninstall removes the shim/managed checkout only; `muxr uninstall` performs bounded operational teardown while preserving Herdr sessions, repositories, worktrees, and received user artifacts.

### Plugin acceptance

A clean isolated user with real Herdr and no muxr on PATH must complete:

```text
install exact plugin source
→ review build
→ verified exact CLI installed
→ open Setup pane
→ inspect plan
→ Apply
→ service healthy
→ browser link
→ pair
→ run one command in a real Herdr pane
→ Doctor passes
→ update to second version
→ panes still operate
→ rollback
→ panes still operate
→ uninstall behavior matches docs
```

No `MUXR_BIN` override, local plugin link, stale npm payload, user service, or pre-existing state may satisfy this gate.

## 7. Configuration and agent contract

Keep `~/.muxr/config.env`; do not introduce TOML/YAML/HCL. One versioned attribute definition generates validation, defaults, provenance, CLI schema/help, TUI Review, JSON plan, documentation, and the agent skill.

Stable desired-state attributes:

- `MUXR_SETUP_ROLE=single-machine|shared-relay|remote-host`
- `MUXR_CONNECTION=tailscale|tailscale-direct|private|lan|cloudflare|external`
- `MUXR_RELAY_PORT=1024..65535` (default 8792)
- `MUXR_WEB=true|false` (fresh single-machine default true; false must be explicit in automation)
- `MUXR_ADVERTISE_URL=<root URL valid for selected route>`
- `MUXR_INTEGRATIONS_SYNC=auto|on|off`
- `MUXR_NOTIFY_EMAIL=<optional validated address>`
- `MUXR_SERVICE_MODE=managed|foreground`
- `MUXR_PAIRING_DEFAULT=browser|browser-view|browser-personal|native|none`
- `MUXR_BUNDLED_PLUGINS=<validated declarative enabled map>`
- `MUXR_EXTRA_PLUGINS=<validated exact-source/exact-ref list>`
- `MUXR_VOICE_PROVIDER=<installed host plugin id or unset>`

Ephemeral secrets/actions are not config attributes: provider keys/OAuth, owner mint credentials, device keys, pairing codes, enrollment strings, and one-use invitations.

Fresh human onboarding remains short: optional add-ons, provider setup, and advanced roles move out of the happy-path questionnaire, but the stable choices remain representable for agents and maintenance.

Required interfaces:

- `muxr config` — human effective values and provenance.
- `muxr config --json` — non-secret effective values/defaults/provenance.
- `muxr config --schema` — key, type, values, default, conflicts, applicability, restart behavior.
- `muxr setup --apply-config --dry-run --json` — same plan as TUI Review; no mutation.
- `muxr setup --apply-config --json` — apply exact desired state, then verify; does not emit invitations.
- Existing `muxr self-host --apply-config` delegates to the same plan rather than independently interpreting six keys.
- `muxr doctor --json` — read-only non-secret health and exact runtime/plugin/source identity.
- `muxr skill onboarding` — every attribute, minimal browser-first example, inspect/plan/apply/verify, secret boundary, pairing handoff, reapply/update/rollback.

Exit behavior: 0 verified/no unresolved failure; 2 valid plan with changes for dry-run; 1 invalid or unavailable prerequisite. An unchanged reapply is idempotent and does not mint/revoke grants or reinstall unchanged plugins.

## 8. Public onboarding storyboard

1. Landing: **Try it in your browser** primary; **Connect your computer** secondary. “Self-hosted, open source, no account. Nothing to install for the demo.”
2. Demo: open the scripted Needs-you session and answer it through the real composer. Persistent scripted-data disclosure remains.
3. Exploration: Files, Changes, Inbox, attachment, New Agent, terminal, and reset remain reachable. Unsupported voice/live preview explicitly require a connected host and never fake success.
4. Connect: show the two Herdr operations first. “Without Herdr” reveals the npm/CLI fallback. Explain that the installable app is served by the user’s computer after setup.
5. Setup: machine check → one browser-capable route recommendation → exact Review/config preview → Apply. No add-on/provider/theme questionnaire in the fresh happy path.
6. Health: relay, host, Herdr, service, integrations and required plugin identities verified. Failure names phase/cause/next action; never prints Complete early.
7. Own-host browser app: Use this browser or Install; consent shows computer, Control/View-only and actual expiry. iOS storage distinction is explicit.
8. First action: open a Needs-you session, or create a disposable shell and run `printf 'muxr-ready\n'`; exact output appears once in the same Herdr pane.
9. Daily return: warm reconnect, terminal/IME, approval, Files/Changes, artifact download, preview, takeover, drafts and retries.
10. Optional: notifications at first request; Talk at first use; host voice setup if unavailable; add-ons/settings later.
11. Native upgrade only where a native capability is requested.

Zero decisions before demo value. A prepared Herdr/HTTPS user should face only plugin trust, route confirmation, Apply, optional install, and browser-grant consent before real value.

## 9. Browser parity contract

Preserve and test these browser workflows against the same frozen candidate:

- Herd, Inbox, Spaces, global attention priority, status and usage.
- New agent, shell, repositories, worktrees and outside-home cwd.
- Terminal attach/retry, modifiers, CJK/IME, software keyboard, copy/links and screen-reader mode.
- Control/View authority and approvals.
- Files, Changes, history, runbooks, text/binary/partial/error truth.
- Attachment upload failure ownership and byte-identical >2 MiB download.
- Preview fixtures and explicit HMR/WebSocket/CORS limits.
- Takeover text/touch/drag/wheel/IME and single-controller arbitration.
- Warm resume, expiry, revoke, re-pair and PWA relaunch.
- Foreground true realtime S2S voice lifecycle.
- Dictation as progressive enhancement when the browser exposes a supported native speech-recognition API; it edits the draft only and never masquerades as realtime S2S. Unsupported browsers state that exact limit. No new model/dependency.
- Existing appearance, terminal font, accessibility, plugin UI and multi-machine controls.

Native-only: background microphone service, multicast discovery, watch/launcher/store integrations and other genuine OS facilities. Do not classify a missing implementation as an OS limitation.

## 10. Documentation contract

The problem is duplication and contradiction, not too few pages. Delete/merge before writing more.

Canonical repository-owned beginner documentation:

1. `docs/user/introduction.md` — what muxr does/does not do; browser/computer/relay in three lines; demo versus real host; UI vocabulary.
2. `docs/user/install.md` — requirements; Herdr-first install; npm fallback; Setup pane; route prerequisite; Review/Apply; optional install; pairing; first action; Doctor.
3. `docs/user/daily-use.md` — terminal, attention, approvals, Files/Changes, attachments, creation/worktrees, preview/takeover, recovery, voice/dictation/notifications and native-only differences.
4. `docs/user/configuration.md` — generated attribute table, provenance, plan/apply/verify, advanced network/shared relay, plugins, provider secret boundary, update/rollback/uninstall.
5. `docs/user/trust.md` — E2EE, relay visibility, browser roles/lifetimes, shell authority, preview origin, revocation, provider data and compromised-device scope.
6. `docs/user/troubleshooting.md` — symptom → safe check/command → expected result → next action for every primary failure.

Every page answers one question, puts prerequisites before the command, gives runnable commands separately from grammar/placeholders, and ends with one concrete Next action. Maximum two pages before first real action.

Maintainer docs—architecture, ADRs, specs, release process, native build, compatibility, smoke plans, license inventory—remain available under Developers/Maintainers and never appear as beginner setup choices. `docs/PLUGINS.md` remains the muxr extension-authoring contract under Develop, not the third beginner nav item.

The website imports the six exact Markdown sources and navigation/redirect metadata from the frozen pockit commit through the existing immutable sync and locks their hashes. It does not maintain independent setup/voice/plugin rewrites. README/package README/skill excerpts derive from the same command/schema/release-facts definitions.

Generated release facts include package version/integrity, source SHA, minimum Herdr version, default port, pairing/enrollment/grant lifetimes and current native-channel availability. No stale hard-coded versions in evergreen install prose.

Documentation gate:

- all relative links, anchors, images and redirects resolve;
- external prerequisite/download/source links checked at release;
- every copyable command matches CLI/Herdr syntax and runs in its declared environment;
- no copyable placeholders, shell `a|b` alternatives, prompt markers, secrets in argv, or maintainer-only paths;
- primary Connect surfaces share byte-identical Herdr commands;
- numeric facts derive from constants/release facts;
- website docs hashes equal frozen pockit docs;
- a fresh-context reader answers within five minutes: what runs where, exact Herdr install, npm fallback, PWA/native optionality, HTTPS requirement/LAN alternative, pairing expiry/access lifetime, Control authority/revocation, config apply/verify, and first useful action;
- the same reader follows the rendered commands in the prepared clean fixture without undocumented rescue.

## 11. Execution units

### Unit 0 — Integrate and baseline

- Fetch current remotes.
- Create a safety ref.
- Rebase the PWA branch onto current `origin/main` or use the repository’s preferred equivalent while preserving source history and all main changes.
- Retain current main dependency/release state.
- Resolve conflicts by this contract, not older phase reports.
- Run typecheck/architecture/focused baseline only; do not run the full 43-check suite yet.

Acceptance: clean pushed branch; explicit old→new mapping; no accidental dependency/version downgrade.

### Unit 1 — Security/data integrity

Close S1–S4 with focused tests, including real-browser cross-tab wrapping-key initialization and direct-navigation preview isolation. No adjacent refactor.

Acceptance: fake-secret canaries absent; concurrent secrets reload; normal preview works; top-level preview authority fails; update/rollback preserves an operable plugin runtime.

### Unit 2 — Herdr acquisition and lifecycle

Implement section 6, exact install/next-step copy, browser-default pairing and isolated install/update/rollback/uninstall gate using a candidate tarball through a disposable registry fixture.

Acceptance: complete clean Herdr journey with exact loaded source/package/plugin identities and no local links/dev overrides.

### Unit 3 — Config/TUI/skill

Implement section 7 from one attribute definition. Remove optional add-on/provider questions from fresh happy path while retaining later controls and config representation.

Acceptance matrix: single-machine HTTPS, explicit LAN/native, shared relay, remote host enrollment, integrations auto/on/off, bundled plugin enable/disable, one pinned add-on, voice configured/unconfigured, managed/foreground. TUI and JSON plans agree; second apply is no-op; failures never print Complete; skill covers every key and boundary.

### Unit 4 — Funnel, parity and canonical docs

Implement sections 8–10. Preserve production UI and quality-of-life features. Do not redesign working visual language.

Acceptance: exact demo→Herdr→setup→host-PWA→pair→first-action journey; Safari tab path; no native-first fallback masquerading as success; provider-neutral clients; progressive dictation; six canonical pages; doc/link/command/comprehension gates.

### Unit 5 — Functional freeze and one complete candidate gate

Freeze pockit SHA. Produce clean export/package/plugin tuple. Run the full diagnostics suite once with no silent optional skips, then one isolated plugin/config onboarding gate and one bounded Android/shared-code regression if shared/native code changed.

Acceptance: all automatable rows pass against one immutable identity tuple. Any repair is minimal, reruns focused tests, then repeats only invalidated final gates.

### Unit 6 — Real voice and physical proof

Use the existing Codex Voice plugin selected on the host for QA unless it is unavailable; another already configured true realtime provider may be used. Do not add a provider. Run one prepared physical/browser microphone call through the frozen host/plugin/client.

Acceptance: intelligible mic input → real streaming provider → audible generated audio; transcript not duplicated; barge-in interrupts; End/hide releases tracks, peer/data channel and native service; second call starts cleanly; client evidence contains no provider/account/credential/internal ids. Synthetic fixtures remain regression evidence only.

### Unit 7 — Sync website once

Import the frozen PWA export, six canonical docs, commands and release facts from frozen pockit. Apply only website-specific hierarchy/navigation/CTA work required by this contract.

Acceptance: source lock equals frozen pockit SHA; hashes pass; build/tests pass; one CDP route/viewport sweep; `/demo` reload remains credential-free; no manifest/pair/restore/grant surface on marketing origin; responsive/accessibility/motion floors hold.

### Unit 8 — Contract review and PRs

Fresh maximum-effort Astra and Fable receive only this contract, final diff, immutable tuple and evidence ledger. They check numbered requirements; they do not conduct another open-ended craft audit.

Acceptance: no failed numbered line and no P0/P1/security/data-loss issue. P2 taste goes to one follow-up issue. Open pockit PR and dependent website PR with exact release order and residual physical/platform limitations.

### Unit 9 — Publish and public smoke

After merge, publish the matching npm package, add GitHub `herdr-plugin` topic, verify marketplace appearance after refresh, sync website to actual merged public SHA if merge changed it, deploy, and run the public cold journey.

Acceptance: public `/demo` 200; Herdr install works anonymously from empty HOME; runtime/package/source identities match; setup→pair→first action works; public docs show canonical commands and facts; final report records exact SHAs, package integrity, evidence and honest remaining limits.

## 12. Test cadence

- During Units 1–4: only focused tests named by the changed boundary.
- Full pockit diagnostics: once after functional freeze.
- Candidate clean-room plugin/config gate: once after Units 2–4 converge, then once against the real published registry.
- Native build/regression: once only if shared/native boundaries changed.
- Website export/sync: once after pockit freeze.
- Website build/tests/CDP: once after sync.
- Advisor review: once against this contract.
- Physical voice/PWA: one prepared session on the frozen candidate.

Do not rebuild/resync/re-review after documentation wording or unrelated P2 comments unless the relevant acceptance evidence was invalidated.

## 13. Explicit exclusions

No hosted credential-bearing marketing PWA, community gateway, new tunnel service, LAN certificate infrastructure, new realtime provider, STT→LLM→TTS voice replacement, background browser voice, offline shell, new demo scenarios, new theme, broad animation rewrite, additional screenshot matrix, docs generator/CMS/search, localization, pairing-fragment migration, generic provisioning engine, or new abstraction for hypothetical future providers.

## 14. Stopping rule

Implementation stops when Units 0–5 and 7 pass against one immutable candidate, the contract-only review passes, and PRs are ready. If Unit 6 or another genuine physical/provider prerequisite is unavailable, report exactly **release blocked: <missing acceptance row>** and keep the PRs ready; do not fill waiting time with unrelated work.

Release stops only after Unit 6 and the public Unit 9 journey pass. After that, every non-security P2 is backlog. No more “Moshi-level” review, feature expansion, re-theme, additional provider, or old closed finding may reopen this release without naming a failed numbered contract line.

## 15. Current honest state

Astra outcome readiness: 41% overall; Fable branch-level readiness: about 50%, with public shipped outcomes effectively 0% because the candidate is not merged, published, marketplace-listed, or deployed. These percentages do not mean half the product must be rewritten. Most terminal, demo, pairing, preview, takeover, recovery, native, and craft implementation already exists. Missing outcome credit is concentrated in:

- Herdr discovery and install identity;
- complete config/agent equivalence;
- four bounded security/data-integrity defects;
- canonical documentation and truthful acquisition hierarchy;
- final immutable evidence;
- real provider/physical voice proof;
- merge, publish, marketplace, website deploy and public smoke.

## Amendment 2026-09-12 — zero-paste QR acquisition (owner-reopened)

Frozen after independent Astra/Fable planning (`pwa-web-qr-amendment.md`, inputs `astra-web-qr-plan.md`, `fable-web-qr-plan.md`). It narrowly reopens the PWA acquisition contract (sections 1.6, 4's URL-or-QR choice, 6's browser-link step, 8.4–8.7 and the Unit 4/5/7/9 gates); everything else stays frozen. Required journey: Setup and every browser Pair pane print a QR of the exact existing one-use HTTPS link; a phone camera opens the host's `/pair` consent directly (cold-link regression fixed); an unpaired browser or installed PWA leads with **Scan QR to pair** with manual entry secondary; Demo → Connect adds **Scan the QR from Setup**, decodes locally, shows the destination origin and performs one explicit top-level navigation — the marketing origin never claims, resolves, stores, logs or fetches the invitation. Consent, authority, expiry, claim, WebCrypto storage, acknowledgement, revocation and E2EE remain host-owned; scanning grants nothing. Exclusions: no QR format change, fragment migration, new endpoint/authority, TLS weakening, native scanner rewrite, camera on marketing landing/docs, automatic pairing or navigation, background scanner, QR analytics, extra dependency.

Implemented in pockit (this repository): shared `mintDeviceGrant` prints the browser QR and renews the same requested intent on expiry; `pairingIntent().promptLine()` says scan or open; `/pair` cold short links reach consent; `parseBrowserPairingQr` bounds scanned input; `BrowserPairQrScanner` (web-only, native inert) owns `getUserMedia`, one generation/stream/decode/latch and explicit cleanup, prefers a real `BarcodeDetector` with `qr_code` support and otherwise the installed `barcode-detector` ponyfill with `zxing_reader.wasm` served as a hashed same-origin export asset; root/pair/herd empty state lead with **Scan QR to pair**; Demo Connect card handoff; Install/Trust/Troubleshooting copy; `checkDemoFlow.mjs` gains the one browser QR flow and `checkWebExport.mjs` the asset checks. The website companion change (`/demo` gets `Permissions-Policy: camera=(self)` only) lands in the website repository at Unit 7.

## Implementation status

Units are executed on `feat/pwa-primary-channel`. Unit status is recorded here as work lands.

| Unit | Status | Commit |
|---|---|---|
| 0 Integrate and baseline | done | f10c94da (merge), a1b9ca80 (main delta + baseline) |
| 1 Security/data integrity | done | see git log (Unit 1) |
| 2 Herdr acquisition and lifecycle | done | c7fe5481 (+ gate corrections de8c93fa); clean-room gate 20/21, remaining row re-gated at freeze |
| 3 Config/TUI/skill | done | see git log (Unit 3) |
| 4 Funnel, parity and canonical docs | reopened → done | Unit 4 at 8fb01831; reopened by the 2026-09-12 QR amendment (web QR producer, cold intake, web scanner, demo handoff, canonical copy) — see task25-web-qr-implementation.md |
| 5 Functional freeze and candidate gate | superseded | prior tuple at 319a80c0 (tarball `sha512-0tJ5zq…`, web export tree `bd1c5f17…`) is superseded by the QR amendment; a new tarball/export identity and one complete suite are due at the next freeze (hashes recorded there, not before packing) |
| 6 Real voice and physical proof | lead-owned | |
| 7 Sync website once | separate repository | |
| 8 Contract review and PRs | pending | |
| 9 Publish and public smoke | pending | |
