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

1. Finish Start Code/Browser pane launch and verify rich previews on the native app.
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
  - Evidence / current state: APK 9beb12e1 is native-verified with mobile checks and focused command-control PASS. It is an emulator artifact, not the pending ARM64 beta phone release.
  - Remaining / boundary: Integrate reviewed host alignment, finish current gates, publish the tested beta and link its exact APK/provenance.

- [ ] **T07 · Explain every release feature with first principles and diagrams** — In progress.
  - Evidence / current state: Release workflow and task board are available. #224 is being rewritten for the expanded final scope and exact evidence.
  - Remaining / boundary: Include all current fixes, Mermaid flows, actual tests and remaining limitations.

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

- [ ] **T11 · Stop repeated Connected / Reconnecting flapping** — Implemented / verification pending.
  - Evidence / current state: Fixed two reproduced terminal transport bugs in d7d7351c: live now requires the first authenticated host frame, and an old asynchronous decryption cannot close a replacement socket. Existing flow baseline failures retained; fixed 8/8 and TypeScript pass.
  - Remaining / boundary: Final combined runtime gate and sustained phone check remain; do not infer every network failure is resolved.

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

- [x] **T18 · Move or hide terminal controls that cover the browser header** — Done, within stated scope.
  - Evidence / current state: Native APK 9beb12e1 controls gate passed in text and graphics: actual handle moves 348/349 pixels, collapse/restore and bounds pass. The previous failed drags originated at Android’s 30 dp back edge; the whole handle now stays outside it.
  - Remaining / boundary: Position resets when the terminal remounts. Physical-phone comfort still needs your feedback.

- [x] **T19 · Replace the Tools dropdown with a half-circle expansion** — Done, within stated scope.
  - Evidence / current state: Implemented inward-opening five-action command fan, one 44 dp puck and consistent buttons. Native 9beb12e1 gate passed drag, collapse, restore, matching button sizes and no overlap in text and graphics.
  - Remaining / boundary: Final combined APK will include it; compact screens use a reachable row instead of clipping the fan.

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

- [ ] **T24 · Explain current work and PRs instead of repeatedly asking for a name** — Implemented / verification pending.
  - Evidence / current state: Committed bf2ab490: shared backend work-context lookup preserves the named target and accepts expanded context. Existing actual provider flow 11/11 passes named PR follow-ups and redaction.
  - Remaining / boundary: Natural spoken/model behavior still needs acceptance; this does not invent PR data absent from available work output.

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

- [x] **T29 · Zoom and pan image attachments** — Done, within stated scope.
  - Evidence / current state: Committed in #224. Exact APK 250a8803 focused emulator flow passes real image upload, thumbnail pixels, preview, zoom, pan, fit and close.
  - Remaining / boundary: Pinch/double-tap are implemented; the automated pixel flow exercises explicit zoom and drag. Physical-phone feel remains acceptance work.

- [x] **T30 · Show selected attachments as image thumbnails** — Done, within stated scope.
  - Evidence / current state: Committed in #224. Owned RGB image uploads and renders real thumbnail pixels; preview and removal pass on emulator. Historical picker filename/path fixture failures retained.
  - Remaining / boundary: Send/failure restoration is code-checked; do not describe it as a device-proven failed-send flow.

- [ ] **T31 · Render rich attachment formats inside the app** — Implemented / verification pending.
  - Evidence / current state: Integrated 8105a626: bounded offline Markdown/Mermaid, PDF, CSV/XLSX and sanitized HTML/SVG. Browser flow passes nonblank PDF/page navigation, worksheet switching, diagrams and remote-content blocking; mobile typecheck and existing attachment flow 4/4 pass.
  - Remaining / boundary: Fresh native build and actual attachment-row-to-preview device acceptance remain required.

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

- [ ] **T39 · Tap mismatch to keep the app and select a compatible host or app update** — Implemented / verification pending.
  - Evidence / current state: Implemented exact-release managed Linux host alignment with confirmation, protocol/state compatibility, preserved beta identity, private snapshot, restart health/rollback and interrupted-job recovery. Standards and spec reviews pass. Real installed-package flow passes update, rollback, custom data directory, ownership and interrupted recovery.
  - Remaining / boundary: Native Settings entry and final packaged beta still need delivery checks. Compatible version differences do not require repair; missing supported metadata leaves alignment unavailable. No real host changed by the test.

## Latest reported regressions

- [ ] **T40 · Start Code / Browser must create and open a pane** — Implemented / verification pending.
  - Evidence / current state: Generic launcher now uses declared executable/context, verifies the newly created pane and returns validated native navigation. Real host Browser and Code launches both passed; owned user-visible panes remain open.
  - Remaining / boundary: Finish the native Tools-button-to-pane flow on the combined APK.

- [x] **T41 · Preserve ordered graphics updates on mobile** — Done, within stated scope.
  - Evidence / current state: Committed b05b8835: reproduced dropped inline placement in actual write pump, replaced latest-only storage with bounded FIFO and explicit recovery. Existing flow baseline 6/7 then fixed 7/7; native APK 250a8803 full emulator gate passed.
  - Remaining / boundary: This closes the demonstrated dropped-frame bug; it does not establish the physical-phone black flicker or crash is fully resolved.

## Workspace cleanup

- [x] **T42 · Clean obsolete Herdr spaces and shells** — Done, within stated scope.
  - Evidence / current state: Closed 46 confirmed obsolete panes: 34 idle shells, 8 completed agents and 4 old demos. Workspace count 24→8; tab count 65→26. Recoverable inventory archives are attached.
  - Remaining / boundary: Preserved active conversations, current Browser/Code demos, build shells and emulator. No source worktree or saved transcript was deleted.

## Verification and update rules

- Keep historical failures alongside reruns; never reuse old APK evidence for changed mobile/native bytes.
- A passing emulator or provider fixture does not prove physical-phone rendering, account entitlement, real speech or remote audio.
- Update this checklist when an item changes state and link the relevant commit, PR or artifact. No new test matrix or agent swarm is required.
- Current APK 9beb12e1: native build, mobile TypeScript, mobile policy and mobile flows passed; focused terminal controls gate passed. Historical full PASS at e5e5a2ae remains pinned to its older APK. Final combined full/rich/live acceptance is still in progress.

## Links

- [Current consolidated polish PR](https://github.com/umeranjum17/muxr/pull/224)
- [Merged terminal polish / channel workflow](https://github.com/umeranjum17/muxr/pull/222)
- [Merged release cache fix](https://github.com/umeranjum17/muxr/pull/223)
- [Failed first beta run, retained](https://github.com/umeranjum17/muxr/actions/runs/33952896064)
- [Installable older phone preview, build 356](https://github.com/umeranjum17/muxr/releases/tag/preview-840708b0)
- [Release runbook](../RELEASING.md)

## Revisions

- 2026-09-05: Created one session-wide tracker at the user's request, including latest thumbnails and movable-toolbar requests, evidence limits and deferred production promotion.
