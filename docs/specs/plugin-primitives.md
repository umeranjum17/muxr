---
title: Plugins on primitives
slug: plugin-primitives
status: tested
created: 2026-08-15
updated: 2026-08-17
owner: umer
links:
  - ../decisions/0005-pi-like-extension-runtime.md
  - ../PLUGINS.md
---

# Plugins on primitives

## Context

muxr called Inbox, Attachments, Changes, Voice, and the rest "plugins" while each still owned a private React component in the APK (`muxr.attachments`, `muxr.inbox-content`, …). That caste is the confusion. There are not two kinds of plugin. Some packages ship in the box as starting points. All of them compose the same compiled primitives. Kernel stays small and snappy; file bytes and git lists are pulled when a pill opens, never pushed down the session event path.

The power this unlocks: today's bundled Voice plugin adapts xAI speech-to-speech behind a provider-neutral `host.stream`. Tomorrow someone disables it and enables an OpenAI or Gemini Live adapter. Every provider uses the same generic PCM channel, `icon-button` controls, overlay, and semantic capability; the phone never names a provider or owns optional Voice policy.

## Approach

Five public platform concepts, with optional product features outside them:

1. **Kernel**: pairing, E2EE, relay, session identity, terminal bytes, plugin runtime, OS bridges, secure storage, generic file handoff, and provider-neutral realtime capture/playback/stream transport.
2. **Targets and slots**: named attachment points with explicit context, cardinality, ordering, allowed primitives, and failure behavior.
3. **Primitives**: strongly typed, reusable native components with per-primitive parameter and result schemas. A primitive must not hide an Inbox, Voice, Preview, or other product workflow behind a generic name.
4. **Actions, events, and capabilities**: a closed host-mediated vocabulary for navigation, refresh, copy, URL/file handoff, composer input, notifications, RPC, and OS effects. Privileged behavior remains kernel-owned.
5. **Plugins**: `herdr-plugin.toml` + `muxr-ui.json` + optional backend. Bundled packages and third parties use the same public contracts and no private route, renderer, or capability.

Enabled Herdr plugins remain intentionally trusted and default-on. Enabling or linking the plugin is the user's trust decision; this rework does not add per-device hash reapproval. Explicit disable and revoke remain authoritative.

### Rework phases

1. Make slot/primitive compatibility, required context, and bounded per-primitive `params` machine-validated instead of accepting impossible combinations that silently render nothing. Both composer slots expose the same draft contract.
2. Use one closed, phone-validated action vocabulary for rows, buttons, settings, and RPC-backed item lists. Add correct refresh-after-write, cache invalidation, diagnostics, version negotiation, and action/event mode validation.
3. Keep Android foreground-service/keepalive ownership unconditional in the kernel. Voice, Inbox, Workspace, Dictation, and run-server presentation are now plugin contributions over generic controls, collection/tree/item-list primitives, bounded host context, and closed kernel actions. The primitive registry contains no product Preview behavior.
4. Harden RPC process termination, isolate plugin concurrency, and replace repeated full catalog reparsing with stable snapshot caching.
5. Publish schema/tooling and verify bundled plus adversarial third-party plugins through local Android builds and authentic emulator flows.

`openPluginStream('voice.session')` resolves the single enabled provider and rejects ambiguous claims until the user disables all but one. The phone sends and receives only bounded generic PCM, control, state, and transcript frames over the encrypted stream. Provider URLs, authentication, models, prompts, tools, and event vocabularies stay in the backend adapter. A replacement provider reuses the same controls, overlay, settings actions, capability, and channel; it never requires a React Native branch.

Attachments and changes list via `plugin.call` (metadata only). Actionable rows carry an explicit validated `PluginAction`; read-only item rows omit actions and render without fake tap behavior. There are no feature-specific tap fallbacks. The host no longer publishes `session.attachments` or `session.changes` onto the phone JS thread. `status.update` updates the session row only when the lifecycle word actually changes; it does not refetch the herdr tree.

RPC contributions may explicitly request `sessions` and/or `workspace-tree`. Immediately before spawn, the host passes a fresh bounded `MUXR_PLUGIN_CONTEXT_JSON` with stable muxr session ids, labels, cwd/workspace/tab labels, agent kind/status, attention timestamps, and label-only tree relationships. It never includes secrets, terminal bytes, device ids, pane ids, workspace ids, tab ids, or other internal ids; records and bytes are capped. Inbox consumes `sessions` and owns grouping, ordering, wording, and the six-hour done TTL. Workspace Hierarchy consumes `workspace-tree` and owns tab/session labels, current state, status, and navigation actions. Its old New tab, split, tab-grid, save/restore layout, close/watch/focus operations are deliberately omitted until they fit declared write RPCs without exposing internal ids; they must not return as React Native product policy.

Run Server now owns Linux/macOS listener discovery, project-cwd filtering, HTTP probes, labels, refresh cadence, and whether its generic `item-list` control exists. UI version 5 removes `url-chip`; active-only bounded item-list polling stops when unfocused and force-refreshes on open. The plugin returns only a validated `{ target: "preview", port }` kernel action. The compiled preview route/transport owns `preview.list` fallback and `preview.attach`; no primitive calls either request or accepts an arbitrary HTTP/file URL.

The Usage plugin uses the exact pinned ccusage native package as its backend aggregator. It runs one bounded `daily --last 1 --by-agent --json --no-cost --offline` read over local agent logs, allowlists names and total-token counts, and never exposes costs, prompts, models, or session details. Its generic item-list distinguishes measured activity from installed-but-unreported agents, including agents ccusage does not support, and caches only the final bounded item model for one minute. Codex current limits still come from its local app-server; other coding CLIs are detected through PATH but never executed.

UI version 13 makes dynamic plugin data genuinely visual without creating a plugin layout engine: progress may bind one bounded numeric data path; sections may arrange safe summary nodes in two or three responsive columns; and one bounded `chart` node renders app-owned bar or ring presentation with a visible text legend and full accessibility summary. Series are capped, plugins cannot supply colors, markup, axes, animation, or interaction, and malformed runtime values degrade to an empty state. Usage is the load-bearing proof: today’s measured agent activity and Codex limits use the same public nodes available to every third-party plugin.

UI version 12 allows generic `item-list` rows to omit actions for read-only status/metric presentation while preserving closed validation for actionable rows. UI version 11 adds a bounded declarative `code` node with app-owned Prism tokenization, line numbers, selection, shared theme tokens, and plain-text fallback. The same tokenizer now powers native/web file views, Markdown code fences, and native diff lines, replacing the duplicate hand-rolled regex highlighter. File previews read at most 24 KiB / 240 lines and report truncation; ordinary text remains capped at 4 KiB while a sanitized RPC result string may use the existing 64 KiB total transport budget. UI version 7 adds plugin-owned navigation badge read sources and singleton tree-sheet cardinality. UI version 6 makes user-visible manifest strings bounded localized values with exact-locale, base-locale, then default fallback on the phone. The same public `shortcuts` contribution drives build-time localized Assistant resources and the live Android launcher projection. Runtime-installed plugins cannot add Assistant capability bindings because Android only accepts those from packaged XML; a third-party plugin included in a custom build receives the identical build-time behavior.

## Files

- `packages/contract/src/plugins.ts`, `manifest.ts` — target, primitive, action, event, parameter, public-context, and compatibility vocabulary
- `apps/mobile/sources/plugins/collectionModel.ts`, `treeModel.ts` — bounded phone-side response/action validation
- `apps/mobile/sources/components/code/`, `SimpleSyntaxHighlighter.tsx`, `diff/PierreDiffView.tsx` — one bounded Prism tokenizer and themed native/web renderers for source and diffs
- `apps/mobile/sources/plugins/primitiveRegistry.tsx`, `slotTypes.ts` — typed primitive renderers plus compile/runtime context guards
- `apps/mobile/sources/plugins/pluginActions.ts` — bounded action validation and dispatch
- `apps/mobile/sources/components/KernelNotifications.tsx` — unconditional foreground-service and baseline notification owner
- `apps/mobile/sources/plugins/primitives/` — the compiled widgets
- `apps/mobile/sources/voice/realtimeSession.ts` — token `url` + `transport`
- `plugins/voice/stream.mjs` — boxed xAI adapter for the public provider-neutral `voice.session` stream; `rpc.mjs` owns only key lifecycle and report wording
- `plugins/*/muxr-ui.json` plus RPC sources, including Inbox, Workspace Hierarchy, and `plugins/run-server/rpc.mjs`
- `apps/host/src/herdr/pluginPublicContext.ts` — sanitized bounded public context snapshots
- `apps/host/src/herdr/herdrSessionSource.ts` — session context on `plugin.call`; stop pushing attachment/change events
- `apps/mobile/sources/sync/sync.ts` — no herd-tree RPC on status ticks
- Shell slots mount primitives without naming voice/dictation/inbox/run-server/Preview; `_layout` mounts only kernel notification infrastructure

## Verification

- `node scripts/runSuite.mjs` passes 29/29, including the structured Usage agent-item flow and actionless read-only item-list rows; `node scripts/checkBundledPlugins.mjs` validates all 17 bundled plugins and rejects wrong target/primitive/parameter combinations.
- The mobile typecheck, focused manifest/tokenization flow, web export, and Android production JS bundle all pass with the v11 `code` node.
- Workspace and mobile typechecks pass; focused Android acceptance checks pass 62/62.
- Existing host/mobile flow tests cover catalog snapshots, explicit disable/revoke, event/action modes, write refresh, timeout isolation, cache invalidation, and process-group cleanup.
- Adversarial fixtures prove malformed, incompatible, hung, oversized, and rapidly changing plugins fail locally without blocking the host or phone.
- A local API 36 x86_64 release APK installs and completes cold E2EE pairing, catalog/settings, generic navigation and forms, CollectionView, ItemList, TreeSheet, mutation refresh, explicit disable/remount, localization fallback, dynamic and static shortcuts, concurrent calls, secure prompts, TalkBack activation, rotation, microphone foreground-service lifecycle, and bounded dictation on the emulator. The provider-neutral realtime stream reaches Listening through strict E2EE with its backend adapter and microphone FGS active, then stops its adapter/recording and downgrades the shared service cleanly. Physical-device microphone/speaker AEC and barge-in remain a manual check.
- Android 16 Live Updates verification starts with promoted access off, shows one lifecycle prompt, opens the exact system setting, persists the prompt, reflects off/on after return, and reposts an ongoing working notification with `requestPromotedOngoing=true`, short critical text, and native promotion access enabled.
- Item-list UI verification proves distinct Changes/Files pill icons, git-status and MIME-aware row icons, green additions/red deletions, file and attachment row dispatch, and an independent temporary plugin’s sheet-level action dispatch. A 177,321,373-byte APK also downloads fully over hosted E2EE chunks, matches its source SHA-256, and reaches Android’s share handoff without loading the blob into JS memory.
- Live xAI backend smokes return PCM audio plus transcript and complete a real `list_panes` tool call. The phone receives only generic stream frames; provider authentication/model/prompt/tools/events remain in `plugins/voice/stream.mjs`.
- UI version 10 device acceptance proves File Viewer starts as a compact folder tree, lazily expands deep folders, collapses/expands loaded branches, and opens a text file. Runbook selects a non-default repository folder, executes there, and retains the selected folder after write refresh.
- Independent architecture, performance, security, correctness, UX/accessibility, dead-code, public-core, Live Update, item-list, realtime-stream, and declarative-tree reviews have no unresolved blockers.
- Final phone artifact: `muxr-preview-arm64-v8a.apk`, SHA-256 `717e6365adb7ed55f55cab41b755fc5393e58a15e805d17c570987e211cbdce7`; ARM64-only, target SDK 36, APK v2 signature verified.

## Revisions

- 2026-08-17 — Reopened for bounded dynamic presentation: add data-bound progress, responsive summary columns, and one app-owned bar/ring chart with capped series, visible legends, and no plugin colors, markup, animation, or executable UI.
- 2026-08-17 — Reopened Usage presentation: replace the flat text card with read-only item-list rows and report every installed known agent honestly as measured, no activity reported, or unsupported by ccusage.
- 2026-08-17 — Usage now delegates local multi-agent activity to an exact pinned ccusage backend in offline/no-cost mode while retaining the bounded local Codex limit API and never invoking other coding CLIs.
- 2026-08-17 — Unified file, Markdown, plugin code, and native diff highlighting on the existing Prism dependency so third-party plugins receive the same bounded renderer without HTML or native modules.
- 2026-08-15 — Replace feature-named native renderers with primitives; attachments/changes become pull RPCs.
- 2026-08-15 — Primitives are slot-agnostic and may repeat in one slot. Initial Voice token transport contract added (superseded by the provider-neutral backend stream on 2026-08-16). Herd tree no longer refreshes on every status tick.
- 2026-08-15 — Phone is a translator of `muxr-ui.json` (slot + primitive + parameters). Host plugins do the heavy work. Deleted ChangeTracker, `session.changes` / `session.attachments` events, and the phone catalog store.
- 2026-08-15 — Reopened after the open-source extensibility audit: make primitives and slots first-party platform concepts, remove feature-specific shell ownership, harden runtime lifecycle/performance, and prove the public contract on Android.
- 2026-08-15 — Safety slice 2: foreground keepalive moved to unconditional kernel ownership; removed the notification plugin slot/wrapper; UI version 2 adds typed primitive context, bounded params, and a closed action contract; Dictation now owns both composers; item RPCs dispatch only validated explicit actions.
- 2026-08-15 — Native generalization slice 3: MainView no longer names Voice; cold shortcuts and controls call the app-level realtime action directly; Voice contributes both generic buttons, provider-neutral overlay, declarative settings, secure credential prompt, destructive clear confirmation, and its shortcut. UI version 3 removes `orb` and feature-owned Voice primitives.
- 2026-08-15 — Native generalization slice 4: `feed` and feature-owned workspace rendering are gone. UI version 4 adds source-driven `collection` and `tree-sheet`, allow-listed public RPC context, and a primitive dependency guard. Inbox/Workspace grouping and wording moved into bundled RPC plugins; workspace mutating/grid/layout operations that need internal ids are omitted from the sheet until exposed through safe declared writes.
- 2026-08-15 — Native generalization slice 5: removed `url-chip`, `PreviewHeader`, and mobile run-server launch policy. UI version 5 gives generic `item-list` bounded icon/accessibility/active-refresh parameters; adds current-session preview navigation, capability actions, Assistant shortcuts, the realtime indicator, and singleton overlay cardinality. Run Server owns cross-platform listener discovery and emits generic rows; kernel preview list/attach/viewer remain transport substrate.
- 2026-08-15 — Public parity slice 6: bounded localized manifest values preserve Inbox's shipped locales and apply to every user-visible declarative field. Android projects all live shortcut contributions into deterministic dynamic launcher shortcuts; packaged plugins use the same public contribution for localized Assistant App Actions.
- 2026-08-15 — Runtime hardening slice 6: RPCs use cancellable process-group deadlines with SIGKILL escalation, prompt revoke fencing, global/plugin/device admission caps, bounded timing diagnostics, and file-identity manifest projection caching. Default-on enabled-plugin trust remains unchanged.
- 2026-08-15 — Mobile runtime hardening slice 7: every plugin call uses the shared client deadline; invalidation frames retain plugin ids; manifests are cached by immutable hash; only affected data surfaces refetch; successful writes reload their screen data; and ambiguous retries reuse hashed-input idempotency keys without retaining secret plaintext.
- 2026-08-16 — Final reliability and Android acceptance: centralized phone-side RPC admission, stale-response fencing, localized failure states, rotation-safe and TalkBack-operable realtime controls, Android runtime shortcut compilation, host context hardening, independent no-blocker reviews, 27/27 automation, and authentic API 36 release-build E2E.
- 2026-08-16 — Reopened to restore Android’s promoted Live Update island for working/busy agents. The ongoing lifecycle notification still requested promotion, but a fresh package had no access check, settings route, or user prompt when Android withheld promoted presentation.
- 2026-08-16 — UI version 8 makes `item-list` responses presentation-complete without feature branches: bounded per-row icons and metadata plus optional sheet-level closed actions. Changes emits line additions/deletions and git-status icons; Attachments emits MIME-aware icons.
- 2026-08-16 — Realtime provider policy moved entirely behind public `host.stream`: React Native keeps generic PCM/WebRTC capabilities and provider-blind frames; the bundled backend adapts xAI Grok, runs tools next to Herdr, and fences revocation/admission/backpressure. Hosted large attachments now stream bounded encrypted chunks to device storage. Removed Usage, Machine, and Example clutter from the home navigation strip.
- 2026-08-16 — Reopened for UI version 10: generic declarative trees now own bounded expand/collapse-all, lazy child loading, closed leaf actions, and folder-to-field selection. File Viewer becomes a hierarchical lazy explorer; Runbook validates and executes in a selected repository folder.
