---
name: "herdr-company-hierarchy"
description: "Optional executive workflow with strict pane authority, native DeepSeek/Luna subagents, decomposed teams, emulator-first acceptance, clean trunk delivery, and cleanup"
version: 18
created: "2026-08-08"
updated: "2026-08-08"
---
## When to Use
Use only when the user opts into this company workflow. The executive exclusively controls herdr resources and release gates. Leads coordinate native in-pane subagents and bounded specialist work; independent QA proves runtime behavior before founder delivery. Never encode this workflow into generic product behavior.

## Research Before Trial-and-Error
Any agent that is confused/uncertain/facing an unfamiliar error MUST search web/official docs for the exact error and root cause before writing a fix or triggering a rerun; mandatory before every expensive cycle (native/Gradle builds, emulator instrumentation, device installs, release artifacts, deployments); cite the doc/issue found alongside fix+SHA, "tried something" is not an acceptable report; when a failure class appears (SDK API removal, JNI/runtime restriction, toolchain daemon crash) research the whole class and fix all known instances in one commit; repeated guessing at documented platform behavior is a process failure.

## Procedure
1. Treat this as an optional orchestration skill only; never generic product runtime code.
2. Transfer `executive` to the founder's terminal. Executive alone owns herdr workspaces, tabs, panes, persistent agents, worktrees, assignments, closure, release gates, and final integration.
3. HARD MECHANISM BOUNDARY: leads must never invoke the herdr CLI, socket, API, or skill to create/start/assign/close panes, tabs, workspaces, agents, or worktrees—not even for a read-only scout. In lead briefs, `scout`, `researcher`, `context-builder`, and `worker` always mean native in-pane subagents. If native subagents are unavailable, callback blocked; never substitute a herdr pane.
4. Every executive prompt to a lead must repeat: native subagents only; no herdr commands; no generic delegate/heavy role; report role/context/resolved model/fallback. Do not rely on inherited policy text alone.
5. Native model mapping: scout/researcher/context-builder primary `opencode-go/deepseek-v4-flash`, fallback `openai/gpt-5.6-luna`; worker primary `openai/gpt-5.6-luna`, fallback `opencode-go/deepseek-v4-flash`. HARD RULE: Luna is only ever reached through the `openai` provider — `opencode-go/gpt-5.6-luna` and any other non-openai Luna route are forbidden, as primary or as fallback. DeepSeek stays on `opencode-go`. Existing explicitly approved runs may finish; every new run uses this mapping.
6. After any delegation prompt or callback, executive reconciles `herdr agent list`/tabs. Any unauthorized persistent subagent pane is immediately stopped and cleaned; the lead is corrected before more work.
7. Assign one accountable integration owner per feature/workstream through acceptance, trunk delivery, release note, and cleanup. Accountability does not mean one team implements every subdomain.
8. Decompose separable technical domains into bounded executive-provisioned specialist teams with dedicated worktrees, explicit file/contract boundaries, and no overlapping writers. The integration owner coordinates callbacks; only executive creates those teams.
9. Keep main clean and integration-only. Executive alone provisions and removes writer/build/QA worktrees.
10. Before implementation, create an acceptance contract covering real user journeys, lifecycle/platform states, primary/fallback/failure behavior, runtime evidence, and unchanged critical flows.
11. For shared resources or cross-cutting lifecycle—microphone, camera, audio routing, auth, storage, networking, background services, navigation, deployment—inventory every consumer and create a regression matrix before code/build.
12. Use the smallest coherent candidate. Do not combine hardware-unverified features or broad historical tree replacements by default. Large combined/replacement-tree candidates require founder approval, exact provenance, and the full matrix.
13. Leads route decisions to executive; no trapped local questionnaires. Any downgrade, disabled requirement, expanded blast radius, missing evidence, or model substitution returns to founder.
14. Code/tests/build/archive checks are necessary but not runtime proof. Executive provisions an independent QA owner—not a writer—to install the exact artifact on a local emulator/device and exercise every supported matrix scenario before founder delivery.
15. For Android, emulator/device QA covers install/launch, UI/layout, notification actions, keyboard, existing workflows, permissions and service/state transitions where supported. Real-device-only behavior is explicitly separated, never waived.
16. A founder-owned personal device remains standby-only until the founder approves a bounded exact test script/window. No surprise installs, launches, taps, settings, recordings, logs, resets, or monitoring.
17. If local runtime validation is unavailable, status is blocked/unverified. Founder must never be the first integration tester.
18. Record exact base/candidate/host/artifact SHAs. Build only latest trunk plus the smallest accepted feature set; never stale/superseded candidates.
19. Callbacks are best-effort. Reconcile every 2 minutes for active teams, 5 minutes for long-process-only state, and immediately when overdue; batch status and inspect changed/done/blocked panes.
20. When acceptance fails, freeze builds/scope, update the matrix, and split distinct failure domains into bounded executive-provisioned specialist owners while retaining one integrator. Never let a lead create debug panes.
21. Only after specialist checks and independent runtime QA pass may executive deliver to founder, integrate cleanly into local/remote main, issue a truthful release note, and clean all panes/worktrees/temp/TODOs.

## Pitfalls
- Do not confuse one accountable owner with one overloaded implementation team.
- Do not use the words scout/worker without explicitly saying native subagent only and naming the model.
- Do not allow leads to call herdr for any helper; inherited herdr access is not permission.
- Do not let founder become the first real integration tester.
- Do not accept source markers/unit tests as proof of shared-resource or hardware behavior.
- Do not bundle unrelated or independently unverified features merely to reduce build count.
- Do not transplant broad historical trees without explicit provenance and regression acceptance.
- Do not create overlapping writers or vague debug teams.
- Do not code/build in main, force-push, silently downgrade, use wrong models, or leave clutter.
- Keep process proportional, but never simplify away runtime proof or pane-authority enforcement.

## Verification
1. After each delegation, confirm `herdr agent list` contains only executive-provisioned persistent agents; close violations.
2. For every native child, record role, fresh/fork context, resolved model, and fallback activation.
3. Confirm scouts use DeepSeek V4 Flash primary on opencode-go, workers use GPT-5.6 Luna primary, and that every Luna route resolved through the openai provider. Any opencode-go Luna route is a violation.
4. Name executive, integration owner, bounded technical owners, and independent QA owner.
5. Confirm each specialist has an executive-provisioned worktree and explicit non-overlapping scope/contract.
6. Confirm blast-radius inventory and regression matrix for shared-resource changes.
7. Confirm smallest coherent candidate and approval for broad combined/replacement-tree work.
8. Confirm independent emulator/device/service validation ran against the exact artifact before founder delivery.
9. Confirm founder-owned device interactions occurred only inside an approved bounded window.
10. Confirm all affected existing/new flows passed on exact candidate/host/artifact SHAs.
11. Confirm clean trunk integration, accurate release note, and immediate cleanup only after acceptance.