---
title: Release and polish task tracker
slug: release-polish-todo
status: in-progress
created: 2026-09-05
updated: 2026-09-05
owner: coyote
links:
  - https://github.com/umeranjum17/muxr/pull/224
  - ./release-channels.md
---

# Everything we discussed: release and polish TODO

Snapshot: 5 September 2026. This is the session-wide checklist, not a claim that every item is in the current APK. **Checked means the stated scope is done. Implemented, merged, tested and available on your phone are different milestones.**

Current product PR: [#224](https://github.com/umeranjum17/muxr/pull/224), draft. Release #209 and follow-ups through #223 are merged. Production promotion remains deferred until you request it. No automated beta has published successfully yet.

## Next execution order

1. Finish thumbnails and movable controls; include them in the current polish PR.
2. Freeze the combined source, build and verify all changed UI plus the full local gate.
3. Complete review/CI, merge the polish, publish and verify the beta, then provide the phone APK link.
4. Continue the visible backlog: terminal reconnect/flicker/crash, realtime grounding and broader tools, rich previews and the Tools interaction. These remain explicit beta limitations until resolved.
5. Promote production only after your acceptance.

## Release and delivery

- [x] **T01 · Consolidate the release and close superseded feature PRs** — Done, within stated scope.
  - Evidence / current state: Release #209 and follow-ups #211–223 are merged. Current product work is together in draft #224; unrelated dependency PRs remain open.
  - Remaining / boundary: Continue adding this polish to #224; review dependency upgrades separately.

- [x] **T02 · Implement dev / beta / manual stable channels for npm and Android** — Done, within stated scope.
  - Evidence / current state: Merged #222; exact green source, immutable artifacts, channel-aware updates, Android build-number ledger, separate dev app identity. Local package/native identity checks passed.
  - Remaining / boundary: Production stays manual; beta uses the existing app identity and data.

- [x] **T03 · Fix the first beta pipeline failure** — Done, within stated scope.
  - Evidence / current state: Merged #223: ignore generated Bundler cache paths without weakening source provenance. Normal CI passed.
  - Remaining / boundary: This fixes the diagnosed build blocker; it does not prove publication.

- [ ] **T04 · Publish the first successful automated beta** — Not done.
  - Evidence / current state: The only release-candidate run, 33952896064, failed before Android build; no automated beta release or npm beta publication exists yet.
  - Remaining / boundary: After current polish passes, merge, select green main, rerun beta and verify npm tag, APK/AAB, hashes and signatures.

- [x] **T05 · Provide an installable phone preview** — Done, within stated scope.
  - Evidence / current state: Signed ARM64 preview build 356 is public at preview-840708b0, linked in #222. Application/native parity and prior local gate passed.
  - Remaining / boundary: It predates #224. Do not mistake it for the new settings, zoom or thumbnails build.

- [ ] **T06 · Attach the latest polished APK to the PR and notify you** — Not done.
  - Evidence / current state: The new 7751f730 build is an emulator APK only. No current polished ARM64 phone artifact is published.
  - Remaining / boundary: Publish the tested beta APK, link it on #224, and send the install link with version/build.

- [ ] **T07 · Explain every release feature with first principles and diagrams** — Implemented / verification pending.
  - Evidence / current state: Release workflow HTML and Mermaid diagrams are delivered; #222 and #224 describe feature behavior and evidence.
  - Remaining / boundary: Update #224 for thumbnails and movable controls, then reconcile the final description with the final diff.

- [ ] **T08 · Promote a stable production release** — Deferred / explicit decision.
  - Evidence / current state: Intentionally not performed. Your instruction is beta first, stable only after your acceptance.
  - Remaining / boundary: Retain the candidate evidence and wait for your explicit promotion instruction.

- [ ] **T09 · iOS, OTA and parallel isolated CLI host installs** — Deferred / explicit decision.
  - Evidence / current state: Not delivered by the Android/npm channel work; explicitly outside the first rollout.
  - Remaining / boundary: Keep these visible as future work, without treating Android validation as iOS validation.

## Terminal and tools

- [ ] **T10 · Keep the shell usable when an agent exits** — Implemented / verification pending.
  - Evidence / current state: Merged #222: follow the same live pane from agent to shell to next agent. Existing terminal/catalog flows passed 14/14.
  - Remaining / boundary: Recheck the reported phone symptom; subsequent connection flapping is still open below.

- [ ] **T11 · Stop repeated Connected / Reconnecting flapping** — Not done.
  - Evidence / current state: Phone evidence retained. Host is running without service restarts; attach bursts alone do not identify the cause.
  - Remaining / boundary: Reproduce and capture channel/generation/close evidence, fix the demonstrated cause, retest without navigating away.

- [ ] **T12 · Avoid black frames / flicker while scrolling Terminal Browser** — Not done.
  - Evidence / current state: Physical-phone issue remains unresolved. Browser navigation or a host-side screenshot is not phone pixel proof.
  - Remaining / boundary: Measure the actual phone/native frame transition; retain the prior frame where lifecycle and placement semantics permit.

- [ ] **T13 · Fix Terminal Code gray screen / app crash** — Not done.
  - Evidence / current state: A bounded real Code folder check kept the app PID alive and IME hidden, but your crash is not proven fixed. Explicit keyboard resize still exposed a dark frame.
  - Remaining / boundary: Reproduce the reported interaction with matching native crash/frame evidence and verify sustained use.

- [x] **T14 · Make the terminal keyboard deliberate** — Done, within stated scope.
  - Evidence / current state: Merged #222: Android auto-open defaults off, explicit keyboard button and saved preference. Emulator text/graphics IME checks and real Code folder taps passed.
  - Remaining / boundary: Retain coverage when moving the toolbar.

- [x] **T15 · Reduce Tools to installed application launchers** — Done, within stated scope.
  - Evidence / current state: Merged #222: generic enabled-plugin global actions; current Browser and Code stay, ordinary shells move to Panes. Actual catalog and 80-shell fixture checks passed.
  - Remaining / boundary: New providers use the same declaration contract; no mobile provider ID list.

- [x] **T16 · Open Terminal Browser and Terminal Code for you** — Done, within stated scope.
  - Evidence / current state: Both were opened in user-visible panes; release workflow explanation was provided.
  - Remaining / boundary: Opening a tool does not close the separate rendering/crash bugs.

- [ ] **T17 · Show shell names instead of calling everything Shell** — Implemented / verification pending.
  - Evidence / current state: Implemented and pushed in #224: Herdr label/title, then folder fallback; Shell remains the type. Existing flow checks passed.
  - Remaining / boundary: Verify Home, Spaces, terminal header and tabs on the new APK.

- [ ] **T18 · Move or hide terminal controls that cover the browser header** — In progress.
  - Evidence / current state: Local implementation: draggable handle, tap to collapse, default position midway down the right edge. Not committed or installed yet.
  - Remaining / boundary: Finish layout review, commit, build; verify drag, collapse and keyboard/rotation bounds on emulator.

- [ ] **T19 · Replace the Tools dropdown with a half-circle expansion** — Not done.
  - Evidence / current state: Interactive design prototype exists; it is not in the app or APK.
  - Remaining / boundary: Implement the approved interaction with reachable touch targets and verify it on a narrow phone.

## Realtime personal assistant

- [x] **T20 · Restore provider settings and Codex as the default choice** — Done, within stated scope.
  - Evidence / current state: Merged #215: saved selection preserved, one provider picker, Codex login setup has no API-key prompt. Provider/module checks and real settings switching evidence passed.
  - Remaining / boundary: This proves configuration UI, not successful streaming audio or entitlement.

- [ ] **T21 · Make default Codex voice work end to end** — Implemented / verification pending.
  - Evidence / current state: Native streaming path retained. Past real attempts did not establish speech, remote audio and clean end as one successful flow.
  - Remaining / boundary: Prove service-before-mic, real account handshake, spoken request/reply and end cleanup on a live target.

- [x] **T22 · Select a currently live voice target** — Done, within stated scope.
  - Evidence / current state: Merged #219: fresh session list/tree intersection, stale remembered routes filtered, malformed nested data fails closed. Focused flow 8/8 passed.
  - Remaining / boundary: Keep live-route membership in future voice acceptance checks.

- [ ] **T23 · Use fuzzy lookup, focus, recent panes and full prompts** — Implemented / verification pending.
  - Evidence / current state: Merged #221: shared work inventory, fuzzy matching, phone recent views, focus/navigation, prompt targeting and initial instructions. Provider 11/11 and realtime/dictation 15/15 passed.
  - Remaining / boundary: Real model behavior still needs acceptance; scripted dispatch does not prove natural speech always chooses the right tool.

- [ ] **T24 · Explain current work and PRs instead of repeatedly asking for a name** — Not done.
  - Evidence / current state: Your latest screenshot shows a real gap. Existing read/status tools are present, but reliable work/PR grounding is not complete.
  - Remaining / boundary: Improve shared backend policy and bounded work/PR inspection; verify ambiguous follow-ups use fresh evidence and suggest recent/focused targets.

- [ ] **T25 · Broader personal-assistant / Herdr tool coverage** — Not done.
  - Evidence / current state: Some navigation and delegation tools exist; unrestricted Herdr parity and destructive agent actions are not delivered.
  - Remaining / boundary: Inventory missing actions, implement generic capabilities and appropriate action rules, test natural requests without exposing internal IDs.

- [ ] **T26 · Actually stop when told Go to sleep** — Implemented / verification pending.
  - Evidence / current state: Merged #222: polite stop requests close the shared provider stream; negations and requests addressed to others stay open. Provider/RPC checks passed; fix installed in local host.
  - Remaining / boundary: Confirm actual spoken stop ends mic/audio on the phone; do not infer this from text policy tests.

- [x] **T27 · Keep behavior in generic kernel/backend contracts** — Done, within stated scope.
  - Evidence / current state: Current Tools discovery and shared voice policy/dispatch follow this direction; native speech-to-speech remains intact.
  - Remaining / boundary: Apply the same rule to pending context/tools work. A newly added provider still needs contract and live transport validation.

- [ ] **T28 · Keep the running local host aligned with the tested app** — Implemented / verification pending.
  - Evidence / current state: Last verified deployed host is packaged source 840708b0; it is not every later main/UI commit. New settings fixes read the actual native version.
  - Remaining / boundary: After beta publication, verify/update the intended host and report exact host/app identities together.

## Attachments, viewers and settings

- [ ] **T29 · Zoom and pan image attachments** — Implemented / verification pending.
  - Evidence / current state: Implemented/pushed #224: pinch, bounded pan, double-tap reading zoom, explicit fit/zoom controls and gallery swipe coordination. Native build and TypeScript passed.
  - Remaining / boundary: Verify actual gestures and readable tall screenshots on the new APK.

- [ ] **T30 · Show selected attachments as image thumbnails** — In progress.
  - Evidence / current state: Local composer code replaces filename-only chips, includes remove and tap-to-preview, and retains upload state. Not committed or installed yet.
  - Remaining / boundary: Check upload/remove/send/failure recovery and preview on device, then include in #224.

- [ ] **T31 · Render rich attachment formats inside the app** — Not done.
  - Evidence / current state: Markdown/tables/code/Mermaid, PDF, SVG, HTML reports and CSV/spreadsheets were requested. Dependency preparation is stashed; the renderer is not implemented.
  - Remaining / boundary: Build bounded, sanitized previews with clear unsupported/error states, then validate representative real files.

- [ ] **T32 · Make version mismatch obvious and Settings easier to navigate** — Implemented / verification pending.
  - Evidence / current state: Implemented/pushed #224: actual native version/build replaces stale Expo 0.1.12; Home and top Settings notice link to one Connection & updates page. Duplicate summaries removed.
  - Remaining / boundary: Verify true mismatch visibility, no false same-release beta mismatch, diagnostics and one-tap navigation on device.

- [x] **T33 · Improve code/diff/document reading and line links** — Done, within stated scope.
  - Evidence / current state: Merged viewer work: pan/zoom, narrow controls, CJK row extent, source line labels, real diff route, cold/warm line 200, bounded offline error and recovery. Matching local emulator gates passed.
  - Remaining / boundary: Some individual visual details, including equal-count word marking and full scrub label proof, remain less directly evidenced than the main flows.

## Usage, testing and review

- [x] **T34 · Fix Usage providers and recently used ordering** — Done, within stated scope.
  - Evidence / current state: Consolidated Usage implementation and private-context policy reviewed. Actual implementation fixture flow OMP 150 → OpenCode 300 → OMP 150, selected tabs and recency passed.
  - Remaining / boundary: Go unauthenticated guidance was checked; no fabricated Go account quota or every-provider live-account claim.

- [x] **T35 · Create strong local end-to-end and performance gates** — Done, within stated scope.
  - Evidence / current state: Merged local-only harness: bounded phases, strict mounts, CPU/PSS/frame counters, native cells/framebuffer evidence, APK pullback SHA/native provenance, failure artifacts and emulator ownership.
  - Remaining / boundary: The prior matching full gates passed; every new relevant mobile build needs its own matching acceptance.

- [x] **T36 · Remove emulator-specific GitHub workflows** — Done, within stated scope.
  - Evidence / current state: Removed as requested. GitHub runs normal CI/build/release work; device testing stays local.
  - Remaining / boundary: Keep local evidence linked to exact source and artifact identities.

- [ ] **T37 · Test all current polish before finalizing the PR** — Implemented / verification pending.
  - Evidence / current state: 7751f730 native build passed in 2m03s; TypeScript, mobile policy and 26 files / 94 tests passed. New thumbnails/toolbar are later local edits.
  - Remaining / boundary: Build the final combined source, run full local gate plus targeted UI checks, finish CI/review, then mark #224 ready.

- [ ] **T38 · Independent PR review, comments and final evidence** — Implemented / verification pending.
  - Evidence / current state: Prior component reviews and release consolidation are recorded. #224 is currently draft; all remaining known gaps are listed here.
  - Remaining / boundary: Review final diff, update PR checklist/evidence and close only work actually completed. Avoid declaring code review as phone/audio acceptance.

## One-tap mismatch repair

- [ ] **T39 · Tap the mismatch to get the matching compatible update** — Not done.
  - Evidence / current state: Requested after the tracker was created. Current notice opens guidance only. The channel-aware CLI updater exists, but there is no phone-callable host update action. Published matching release assets can be resolved by exact tag; matching versions alone do not prove protocol compatibility.
  - Remaining / boundary: Tap notice → check app/host identities, supported compatibility and channel → offer the component update → show progress → reconnect and verify. App: exact published APK for the installed application identity, build and signer, then Android confirmation. Host: dedicated capability-backed updater with confirmation and durable result across restart; never arbitrary shell or a silent channel switch. Missing/unpublished builds show unavailable, with retry. Test both directions and failed/interrupted updates before calling this done.

## Verification and update rules

- Keep historical failures alongside reruns; never reuse old APK evidence for changed mobile/native bytes.
- A passing emulator or provider fixture does not prove physical-phone rendering, account entitlement, real speech or remote audio.
- Update this checklist when an item changes state and link the relevant commit, PR or artifact. No new test matrix or agent swarm is required.
- Current 7751f730 checks: native build, mobile TypeScript, mobile policy, and 26 files / 94 tests passed. Later local composer/toolbar changes are excluded from that build.

## Links

- [Current consolidated polish PR](https://github.com/umeranjum17/muxr/pull/224)
- [Merged terminal polish / channel workflow](https://github.com/umeranjum17/muxr/pull/222)
- [Merged release cache fix](https://github.com/umeranjum17/muxr/pull/223)
- [Failed first beta run, retained](https://github.com/umeranjum17/muxr/actions/runs/33952896064)
- [Installable older phone preview, build 356](https://github.com/umeranjum17/muxr/releases/tag/preview-840708b0)
- [Release runbook](../RELEASING.md)

## Revisions

- 2026-09-05: Created one session-wide tracker at the user's request, including latest thumbnails and movable-toolbar requests, evidence limits and deferred production promotion.
