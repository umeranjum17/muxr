---
title: Pi-Parity Extension Phase
slug: pi-parity-extension-phase
status: tested
created: 2026-08-14
updated: 2026-08-20
owner: umer
links:
  - ../decisions/0005-pi-like-extension-runtime.md
---

# Pi-Parity Extension Phase

## Context

muxr has the secure Pi-like extension skeleton: Herdr owns executable plugins, the host validates immutable hash-addressed manifests and explicit disable/revoke, and mobile composes enabled contributions through generic slots. The next phase closes four practical gaps without allowing downloaded React, JavaScript UI, native modules, HTML, or WebViews on phones.

The work ships as four serial milestones. Each milestone must compile and pass its focused flow before the next begins.

The authoring rework closes the remaining human/agent usability gap: installed docs must be discoverable from the CLI, bundled plugins must be safely cloneable outside npm ownership, subcommand help must explain the real operation, and setup must install a managed authoring skill reference without giving agents private APIs.

## Decisions

- Keep `schemaVersion: 1`; additions are backward-compatible contribution types.
- Keep Herdr as the only backend plugin registry and runtime.
- Reuse `extension.call` and `extension.invoke`; do not add `extension.data`.
- Declarative screens support list/detail/form composition with bounded `section`, `list`, `row`, `text`, `metric`, `badge`, `progress`, `divider`, `empty`, `button`, and field nodes.
- Forms support text, switch, and select fields, but never password or secret fields. Screen buttons call declared `host.rpc` only in this phase; pane-targeted `extension.invoke` remains session-only.
- `extension.call` input is capped at 8 KiB of JSON, complete RPC stdout is limited to 64 KiB (rejected when exceeded, never silently truncated before parsing/transport), each transported RPC string is capped at 64 KiB and sanitized; ordinary rendered text is capped again at 4 KiB while bounded code previews may consume the larger value.
- RPC contributions declare `mode: read | write`; write calls require an idempotency key and use the existing replay fence: successful outcomes are retained for five minutes, rejected writes are dropped so a genuine failure re-executes on retry.
- Manifest hashes bind a stable canonical serialization of the complete parsed raw manifest object, including unknown fields, plus source and executable authority, not only the validated projection.
- Package management supports local, GitHub/git, and npm sources, always ending in Herdr link/install operations. npm provenance extends `ExtensionSource` and is read only from muxr-managed materialization metadata bound to extension ID, root, version, and integrity.
- npm v1 runs `npm pack --ignore-scripts`, accepts only exact registry package versions with integrity, rejects escaping/duplicate/link/special archive entries, caps archives at 2,048 entries, 16 MiB compressed and 64 MiB unpacked, installs no dependencies, records package/version/integrity provenance, and requires self-contained backend files.
- npm updates disable and unlink the old live root first, stage and validate a complete replacement, atomically swap with a backup, link disabled, require authority confirmation, then restore the prior enabled state; any failure restores the backup and old link.
- Development reload reuses `muxr extension dev` plus a bounded host catalog poll; no filesystem watcher or second runtime.
- Lifecycle v1 adds one machine-scoped `extensions.invalidated` host frame only. Existing Herdr hooks remain the backend lifecycle API.
- Herdr 0.8.0 exposes plugin lifecycle response variants but not subscribable plugin lifecycle events. A stable `plugin.list` digest poll is the compatibility fallback until Herdr adds them.
- The mobile frame dispatcher, extension snapshot, session contribution cache, and semantic capability cache all invalidate together.

## Milestone 1: Declarative Screens

Add an extension-owned `navigation.content` screen contribution with a closed node vocabulary:

- text
- row/list
- metric
- badge
- progress
- divider
- empty state
- section and bounded list containers
- RPC action button
- text field
- switch field
- select field

Screen data, button actions, and form submission use declared `host.rpc` contributions through `extension.call`. Screen buttons do not invoke pane-scoped Herdr actions. RPCs declare read/write mode; write calls require a client-generated idempotency key and are replay-fenced (a successful outcome replays for five minutes, a rejected write is dropped so it can re-execute on retry). The host enforces manifest size, contribution count, at most 64 rendered nodes (list rows count), depth 4, bounded strings/options, an 8 KiB submitted JSON cap, a 64 KiB total response limit before parsing (rejected when exceeded), a 64 KiB sanitized result-string cap, a 4 KiB ordinary-text display cap, and cross-references. Unknown nodes are skipped safely. Old clients ignore the new contribution. The approval hash binds the complete canonical raw manifest object, so ignored fields still rotate trust. `muxr extension check` is brought onto the same contribution validator vocabulary as the host so every bundled manifest it accepts/rejects matches runtime behavior.

Likely files:

- `packages/contract/src/extensions.ts`
- `apps/host/src/herdr/extensionCatalog.ts`
- `apps/host/src/herdr/extensionCatalog.test.ts`
- `apps/mobile/sources/extensions/DeclarativeScreen.tsx`
- `apps/mobile/sources/extensions/ExtensionSlot.tsx`
- `apps/mobile/sources/extensions/useSlotContributions.ts`
- `plugins/voice/muxr-ui.json`
- `scripts/plugin/application/checkPlugin.mjs`

## Milestone 2: Package Management

Add:

```text
muxr package list
muxr package install <local|github|npm spec>
muxr package update <spec>
muxr package remove <extension-id>
```

Rules:

- Local packages validate then use `herdr plugin link`.
- GitHub packages use `herdr plugin install` with optional pinned ref.
- npm packages require an exact registry version and integrity, use `npm pack --ignore-scripts`, and are rejected above 2,048 entries, 16 MiB compressed, or 64 MiB unpacked. Traversal, duplicate paths, links, devices, and other special entries are rejected. The self-contained package is validated and materialized under `$MUXR_HOME/extensions/` before linking through Herdr.
- npm name, exact version, and registry integrity are recorded as provenance and included in the mobile trust source/hash.
- No npm lifecycle or dependency-install scripts run in v1.
- Git installs retain Herdr's built-in manifest/build preview and interactive confirmation; `--yes` is passed only when the user explicitly supplied it.
- Local/npm package installs first link disabled, display Herdr's parsed authority summary, and require confirmation before `plugin enable`; cancellation unlinks the staged package.
- Removal chooses Herdr `unlink` or `uninstall` from registry source metadata plus recorded npm provenance.
- Updating source or authority rotates the manifest hash and invalidates stale calls; enabled Herdr plugins remain default-on until explicitly disabled on the device.

Likely files:

- `scripts/cli.mjs`
- `scripts/plugin/application/installPlugin.mjs`
- `scripts/plugin/application/checkPlugin.mjs`
- `scripts/release/application/pack.mjs`
- `scripts/diagnostics/application/checkPackageSmoke.mjs`

## Milestone 3: Development Reload and Bounded Invalidation

Poll Herdr's authoritative `plugin.list` from the host at a bounded development-friendly interval, compare a stable catalog digest, and emit one additive machine-scoped host frame only when the catalog/source/authority/manifest changes. Herdr 0.8.0 does not expose plugin lifecycle results as subscribable events, so this is the compatibility fallback; no filesystem watcher or second runtime is introduced:

```text
extensions.invalidated
  reason: linked | unlinked | enabled | disabled | changed
  extensionIds: at most 32 validated extension IDs
```

`apps/mobile/sources/client/muxrClient.ts` dispatches this new host frame on the existing encrypted machine stream to a registered sync handler. Mobile clears and refetches the approved catalog, session contribution cache, and semantic capability cache without reconnecting. The frame contains no extension data, terminal content, paths, prompts, file content, or secrets and grants no authority. Old clients ignore the additive frame. A lost frame self-heals on connection or mount reconciliation.

`muxr extension dev` remains validation plus `herdr plugin link --enabled`. Editing and re-linking a manifest changes its hash, removes stale surfaces, and refreshes connected devices without per-device reapproval.

## Milestone 4: Attachment and File-Review Guardrails

Bound host payloads and mobile work for sessions with many attachments or changed files:

- Keep at most 50 attachment metadata records per pane while adding total/truncated attribution.
- Heal at most 8 missing blobs and 4 MiB per sheet opening; never retry known oversize/unavailable IDs in the same mount.
- Lower whole-file `attachment.fetch` healing to 2 MiB so base64 JSON stays below the 4 MiB frame cap; larger files use existing chunked/download paths. Limit one sheet-open heal burst to 8 files and 4 MiB total.
- Render at most 24 attachment previews/rows and show “showing N of M”.
- Show at most the newest 20 attachment rows in the global Inbox.
- Cap changed-file metadata at 200 while preserving total/truncated attribution; cap aggregate captured patch bytes in one event at 1 MiB in addition to existing per-file limits.
- Keep file and diff content demand-loaded only. Remove the unused eager-prefetch hook so it cannot be reintroduced accidentally; selected-file reads retain existing host bounds.
- Render at most 2,000 diff or source lines and show the omitted-line count.
- Cap the web attachment blob cache at 32 MiB with oldest-first eviction.

These are deterministic guardrails, not pagination infrastructure. They bound transport, JS-thread decoding, storage churn, and React node creation before the APK gate.

Likely files:

- `packages/contract/src/wire.ts`
- `packages/contract/src/selfCheck.ts`
- `apps/host/src/herdr/herdrSessionSource.ts`
- `apps/mobile/sources/sync/sync.ts`
- `apps/mobile/sources/components/SessionAttachmentsPill.tsx`
- `apps/mobile/sources/components/InboxView.tsx`
- `apps/mobile/sources/components/ChangesFileRows.tsx`
- `apps/mobile/sources/app/(app)/session/[id]/file.tsx`
- `apps/mobile/sources/components/PierreDiffView.tsx`
- `apps/mobile/sources/components/SimpleSyntaxHighlighter.tsx`
- `apps/mobile/sources/hooks/usePrefetchFileContents.ts` (remove unused eager path)
- `apps/mobile/sources/sync/storage.ts`
- `apps/host/src/herdr/attachmentWatcher.ts`
- `apps/host/src/herdr/changeDetector.ts`
- `packages/contract/src/sessionEvent.ts`

## Failure Cases

- Unknown screen node: skip that node; preserve valid siblings.
- Invalid screen reference or limit violation: quarantine mobile UI while leaving the Herdr backend installed.
- Old host: skips additive contributions or reports an attributed incompatibility.
- Old mobile: ignores unknown screen contributions and invalidation events safely.
- RPC failure: show bounded error/empty state; never render raw or unbounded executable output.
- Plugin source update: old hash no longer matches; the current enabled snapshot replaces it.
- Lost invalidation frame: next connection or screen mount refetches the authoritative catalog.
- Excessive attachments/files: transport and UI truncate deterministically, expose totals, and remain interactive.
- npm/git install failure: atomically restore the previous materialized version and Herdr link; do not leave a partially linked registry entry.

## Rollback

1. Disable or revoke the affected extension.
2. Unlink/uninstall the package through Herdr.
3. Revert the additive manifest contribution or invalidation event handling.
4. Keep existing `settings.sections`, toolbar, native slots, and backend-only plugins functioning.
5. If package management is faulty, authors can continue using `muxr extension dev <path>` and direct Herdr commands.

## Verification

- [x] Workspace and mobile TypeScript checks pass after every milestone.
- [x] Host catalog flow proves screen parsing, limits, unknown-node isolation, references, canonical raw-manifest hash rotation, read/write RPC declaration, and request/response bounds.
- [x] Mobile flow proves list/detail rendering and safe form submission through `extension.call`.
- [x] Local, git-ref, and exact npm package install/list/update/remove flows execute through Herdr in a sandbox, including cancellation, malicious archive rejection, and rollback.
- [x] Re-linking an edited extension invalidates mobile UI without reconnecting.
- [x] Revocation and hash rotation remove stale surfaces.
- [x] Contract self-check covers the additive `extensions.invalidated` host-frame round-trip.
- [x] Large attachment and changed-file fixtures prove the stated item/byte/line/prefetch limits and truncation attribution without eager content loads.
- [x] The complete 25-check suite stays green plus focused milestone flows.
- [x] Android emulator proves approval, declarative screen interaction, reload, revocation, a metadata-only 3 MiB attachment, 200-of-205 file attribution, and a 2,000-of-3,001-line render bound.
- [x] An independent consumer of the released public contract verifies it independently.
- [x] Packed npm smoke proves installed guide/skill discovery, minimal create, safe clone, detailed help, and direct/symlink package-root rejection.
- [x] Fresh agents create a declarative plugin, an RPC plugin, and a bundled override using only installed package resources; the minimal scaffold cuts measured authoring to 99/86 seconds.
- [x] A real isolated global npm reinstall, uninstall/reinstall, and setup preserve cloned bytes, registry root, and original/clone enabled states.
- [x] A separate emulator cold-pairs to the isolated stack, lists all three agent-created/overridden plugins, and renders live focus-note and system-greeting RPC screens.

## Revisions

- 2026-08-20: Reopened authoring DX after a fresh-agent npm gauntlet. Add `muxr plugin docs`, safe bundled-plugin cloning with rewritten local identity, detailed subcommand help, a packaged/managed authoring skill, truthful validator wording, and isolated install/clone/update survival proof.
- 2026-08-14: Added exact attachment/file-review anti-hang caps and corrected machine-frame dispatch, all-cache invalidation, complete-manifest hashing, npm provenance/transactionality/archive limits, pre-enable authority confirmation, full RPC response bounds, write idempotency, action context, Herdr 0.8 polling fallback, frame limits, and aggregate patch bounds.
- 2026-08-14: Milestone 3 uses a bounded authoritative `plugin.list` poll and the additive encrypted `extensions.invalidated` machine frame; no watcher or lifecycle subscription is required.
- 2026-08-14: Final Android E2E moved the generic phone navigation row below the native header safe area, then proved declarative form writes, live hash invalidation, revocation, metadata-only large attachments, changed-file omission attribution, and the 2,000-line renderer bound. Core passed 25/25, and the spec moved to tested.
- 2026-08-15: Finish the extension-to-plugin conversion leftover: the shell still mounted every `navigation.primary` destination at `/inbox` and titled it Inbox, so a third-party tab could not look like its own surface. The content mount is now `/plugin` (Inbox remains a plugin that uses it), leftover `extension*` identifiers in the mobile runtime are renamed, and the decision record notes that the wire shipped as `plugin.*`.
