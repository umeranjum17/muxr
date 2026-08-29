# 0005: Pi-like muxr extension runtime

- Status: tested
- Tier: T3
- Date: 2026-08-13

## Owner decision

muxr becomes a native extension shell modeled after Pi's TUI architecture. Product capabilities are extensions rather than hard-coded screens. One package installed through Herdr may contain:

- a Herdr backend only;
- a muxr UI contribution only; or
- both halves as one extension.

Bundled plugins include Inbox, Voice, Changes, Attachments, Preview/Run Server, terminal keys, and usage. They install during muxr setup, can be disabled independently, and use the same public hooks and declarative component vocabulary as third-party plugins.

## Honest Pi analogy

The analogy applies to package discovery, hooks, commands, status surfaces, navigation, settings, themes, and lifecycle. It does not mean downloaded mobile code.

Pi extensions execute TypeScript in the TUI process. Store-distributed mobile apps cannot safely download React Native modules or arbitrary JavaScript, HTML, WebViews, render functions, gestures, or event handlers. muxr therefore provides two renderer classes:

1. **Declarative extensions** compose versioned native muxr components. These can be installed entirely from the host and appear on connected phones when the Herdr plugin is enabled.
2. **Kernel substrate** provides compiled renderers and OS bridges already present in the app binary. Realtime transport, the diff renderer, attachment previews, and the terminal emulator use this path.

Plugins use the same extension registry, slots, data selectors, actions, enable/disable lifecycle, and attribution. Kernel renderers are not downloadable plugin code.

## Kernel boundary

The mandatory kernel owns only invariants and substrate:

- device pairing, authentication, E2EE, revocation, and key rotation;
- relay/session/terminal/attachment transport;
- terminal emulation and control authority;
- normalized machine/session state and reconnect behavior;
- secure storage and native OS bridges for microphone, push, files, sharing, camera, and haptics;
- extension discovery, immutable manifest snapshots, schema validation, trust, rendering, action mediation, quotas, and kill switches;
- pairing, consent, account, connection, security, and permission screens. Extensions can never contribute inside these surfaces.

The kernel does not own provider policy, product-specific settings, feature navigation, card layouts, notification copy, or optional capability lifecycle.

## Package and discovery

Every muxr extension is also a Herdr package and therefore contains `herdr-plugin.toml`. It may add a sibling `muxr-ui.json` and backend files:

```text
my-extension/
├── herdr-plugin.toml   # identity and optional Herdr actions/hooks
├── muxr-ui.json        # optional native muxr contributions
├── backend.mjs         # optional host logic
└── README.md           # setup, permissions, data, removal
```

Herdr remains the sole backend plugin registry/runtime. muxr does not create a second executable plugin system.

Herdr currently returns `plugin_root` but discards unknown manifest fields. The muxr host therefore discovers only the fixed direct child `muxr-ui.json`. It opens the direct child relative to the verified plugin directory with no-follow semantics, rejects symlinks, non-regular files, path escapes, and oversized content, then reads and parses from that same descriptor. It canonicalizes JSON with RFC 8785 JCS and hashes a domain-separated envelope containing the exact canonical bytes, extension ID, UI schema major, Herdr registry source kind/owner/repo/subdir/full resolved commit, and capability digest. The capability digest covers every UI slot, selector, data-query implementation kind, Herdr action ID and the registry action command mapping. Protocol v1 keeps only the current validated snapshot in host memory and addresses it by hash. A source change immediately makes the old hash unavailable; enabled plugins continue under the new validated snapshot without per-device hash reapproval. Persistent content-addressed/offline manifest caching is deferred until the first real offline extension use case.

Enabling or linking a Herdr plugin is the user's trust decision. Its UI appears on connected phones by default; each phone can explicitly disable/revoke it. A changed manifest or authority digest rotates the immutable call target but does not change that default-on trust decision.

## Extension protocol

The mobile-facing protocol is separate from Herdr's `plugin.*` action bridge:

- `extension.list` returns enabled extension summaries, source attribution, compatibility, manifest hash, and authority digest.
- `extension.manifest` returns the exact immutable manifest snapshot by ID and hash.
- `extension.invoke` mediates a declared action to the same package's Herdr action.
- `extension.call` runs an enabled, manifest-declared bounded RPC entrypoint. Voice uses semantic `voice.*` capabilities rather than a hard-coded plugin ID.
- `extension.data` remains reserved for a future bounded query protocol; it is not part of protocol v1.

All requests require authentication and E2EE outside explicit loopback development. Unknown major versions fail closed. The wire protocol, UI schema, and each dynamic data schema have independent versions.

## Public hooks

Hooks are named native slots, not arbitrary layout interception:

- `theme.tokens`
- `navigation.primary` and `navigation.settings`
- `home.cards`
- `session.header.leading` and `session.header.trailing`
- `session.toolbar`
- `session.status`
- `session.footer`
- `terminal.key-row`
- `settings.sections`
- `command.palette`
- `notifications.channels`
- extension-owned declarative screens

Protocol v1 exposes `settings.sections`, `session.toolbar`, private `host.rpc` (read/write modes), generic native slots, declarative terminal key rows, navigation/settings items, host-RPC-backed data cards, and declarative `navigation.content` screens. A screen composes the bounded node vocabulary below; its data load, buttons, and form submission run declared `host.rpc` contributions through `extension.call`, never pane-scoped Herdr actions. The mobile shell mounts generic slots only; one central registry resolves compiled renderer IDs for specialized native surfaces. Adding another public slot is a compatibility decision and requires a real extension, limits, failure behavior, and a flow check.

## Native component vocabulary

External manifests compose a closed vocabulary mapped to existing native components:

- `section` and bounded `list` containers;
- `text`, `row`, `metric`, `badge`, `progress`, `button`, `divider`, `empty`;
- bounded `text`, `switch`, and `select` fields on extension-owned screens;
- fixed icon names and semantic tones;
- path-only bindings such as `{{data.remaining}}` into a screen's declared read RPC result.

There is no expression language, arbitrary CSS, custom fonts, remote image, SVG, Markdown/HTML, absolute positioning, script, or plugin-supplied event handler. Unknown nodes are skipped without blanking sibling UI. Screens are capped at 64 nodes, depth 4, and 32 select options; strings are bounded per field; password/secret fields are not part of the vocabulary.

Bundled native extensions register extra renderer IDs at compile time. An external manifest cannot activate an unregistered native renderer.

## Data, actions, and events

Kernel data is exposed through permissioned read-only selectors such as current machine, session, connection, attention, changes, and attachments. Extension-owned dynamic data uses declared versioned queries with response limits and refresh floors.

Actions are a closed union:

- invoke a manifest-declared Herdr action;
- refresh a declared data source;
- navigate within the same extension;
- open a muxr session or kernel-owned picker;
- copy text;
- open an HTTPS URL after confirmation;
- fill, but never silently submit, a terminal/composer prompt.

The phone sends only extension ID, current manifest hash, action ID, explicit context, and an idempotency key. On every invocation, the host reloads the enabled Herdr registry entry, recomputes authority, compares it with the current snapshot, re-resolves the target, and rejects missing context. It never falls back to whichever desktop pane happens to be focused. Idempotency keys are scoped to device, extension, current hash, and action; duplicate keys return the recorded outcome within a bounded replay window and never execute twice.

`extension.call` RPCs declare `mode: read | write`. Write calls require a client idempotency key and are replay-fenced with the same recorded-outcome semantics: one key maps to one input, duplicate keys return the recorded outcome, and the same key with different input is rejected. A successful outcome is retained for five minutes; a rejected write is dropped immediately so a genuine failure re-executes on retry. Input JSON is capped at 8 KiB, RPC stdout is limited to 64 KiB (rejected when exceeded, never silently truncated before parsing/transport), stderr separately at 256 KiB so verbose logging cannot break a successful plugin, each transported result string is capped at 64 KiB and sanitized; ordinary text renderers cap again at 4 KiB while bounded code previews may consume the larger value.

The generic event envelope can carry bounded attributed extension state, invalidation, attention, and notification events. It never gains one wire event type per extension. Event fields are classified by the kernel schema; only explicitly `notification_safe` typed fields may enter notification templates. Arbitrary plugin strings, terminal content, file content, prompts, paths, and secret-bearing fields are never notification-safe.

## Notifications

Notification infrastructure is kernel; notification product behavior is extensible.

The kernel owns OS permission prompts, push tokens, encrypted delivery, background limits, system notification APIs, and user/global safety settings. Extensions own declared notification channels, source events, category, bounded priority, copy, grouping, badge/card presentation, destination, and extension-specific settings.

Extensions cannot request OS permission, use secure/login/update presentation, hide attribution, reveal terminal or secret content, template arbitrary plugin strings, override system/security alerts, exceed user quiet settings, or invoke actions from a notification without normal authority checks.

Inbox ships as a bundled extension using this protocol. A third party may add a new channel or UI. Replacing the kernel delivery bridge is not supported.

## First-party extraction boundary

- **Fully declarative candidates:** terminal key row, theme packs, usage/status cards, settings, command entries.
- **Combined extensions:** Run Server/Preview and Voice backend plus their UI contribution.
- **Bundled native renderers behind extension slots:** Voice conversation, diffs, attachment previews, Inbox presentation.
- **Kernel substrate used by those extensions:** WebRTC/microphone service, git/file transport, encrypted attachment bytes, preview proxy, push delivery, terminal bytes.

"Everything is an extension" means no optional product feature is wired directly into shell navigation or lifecycle. It does not mean security and native substrate are downloadable.

## Trust and security invariants

- Installing any Herdr backend grants unsandboxed code execution as the host user. The trust preview says this plainly.
- Extension UI is always attributed with extension name and publisher. It cannot mimic muxr account, security, permission, or update chrome.
- External manifests cannot provide password/secret fields in protocol v1.
- Every call binds machine, extension ID, registry-derived source, full resolved commit when available, exact canonical manifest hash, and action/query/capability digest. The hash rotates with the complete parsed raw manifest object and authority. Rotation invalidates stale calls; it does not require per-device reapproval for an enabled Herdr plugin. Manifest-supplied attribution is never trusted.
- Manifests and data have byte, node, depth, string, refresh, response, and concurrency limits.
- Browser grants may list and render enabled static manifests and allowlisted `kernel_snapshot` data only. They cannot invoke, use `plugin_process` queries, write settings, mutate terminals, or access secrets.
- Disabling or revoking an extension removes its surfaces on the next catalog reconciliation. Revocation is serialized behind an already-authorized Herdr action, then fences every later action. Backend processes remain governed by Herdr; the UI must never imply Herdr plugins are sandboxed.
- Herdr 0.8 compatibility uses a bounded authoritative `plugin.list` digest poll (single-flight, timer-unref'd, and disposed with the host), not a filesystem watcher or lifecycle event subscription. Changes wake clients through one additive encrypted machine-scoped `extensions.invalidated` frame; mobile clears and refetches all extension caches.

## Failure cases

- Missing UI file: extension remains a normal backend-only Herdr plugin.
- Malformed, symlinked, oversized, or incompatible manifest: reject only that UI, keep the app and backend available, show one attributed diagnostic.
- Unknown slot/component/action/node: skip it and render valid siblings.
- Manifest/source/capability hash change: reject stale calls and refresh to the new validated snapshot; preserve any explicit per-device disable.
- Host offline: protocol v1 shows no extension surface and disables actions. Persistent cached shells and staleness UI are deferred.
- Plugin removed, disabled, or revoked: close its screens and remove contributions on reconciliation.
- Conflicting contributions: deterministic namespace ordering and per-slot caps; extensions cannot set global priority in v1.
- Data timeout or quota breach: stop the request, show bounded failure state, and temporarily suspend that source.
- UI phishing attempt: immutable attribution chrome, denied trust-critical slots, no secret fields, and revocation.

## Rollback

1. App-global renderer kill switch hides all external contributions while preserving bundled fallback navigation.
2. Per-extension disable/revoke removes one extension's UI and remote authority.
3. Host flag returns an empty extension catalog.
4. Disable all plugins on the device to remove their surfaces and remote authority.
5. Unlink the Herdr plugin to remove its backend.

The extension wire protocol is additive. Older apps ignore it; newer apps tolerate an absent catalog. Rollback does not migrate pairing, E2EE, sessions, or Herdr state.

## Review outcome

This record requires two renderer classes, verified sidecar manifest discovery, a closed author/response model, immutable source-to-render trust, independent action/data authority, anti-phishing boundaries, and explicit versioning, quotas, reconciliation, revocation, and kill switches. The executable slice landed after host-bound approval, manifest hashing, revoke fencing, emulator E2E, and the full suite passed.

## Validation

The first executable slice must prove one UI-only example and one combined extension:

1. link a local example with a declarative list/detail/form screen plus read/write RPCs;
2. discover, snapshot, hash, and render an enabled plugin without executing backend code during catalog reads;
3. tamper with the source or any raw manifest field and prove the old hash is rejected while an enabled plugin refreshes to the new validated snapshot;
4. reject a symlink, oversized manifest, unknown major, unknown node, denied slot, over-limit node count/depth, and missing RPC reference without crashing valid siblings;
5. convert Run Server's hard-coded mobile check to an attributed `session.toolbar` contribution and invoke its declared pane action with explicit session context;
6. prove browser grants can read an enabled static manifest but cannot execute data/actions;
7. disable/unlink both packages and prove their UI disappears after reconnect;
8. run typecheck, the flow tests, contract checks, host/package smoke, and the full suite.

Manifest validation is one shared pure parser exported from `@muxr/contract` (used by the host catalog and `muxr plugin check` alike), so the CLI cannot drift from runtime acceptance; it covers every bundled manifest and the same rejection cases as the runtime.

## Amendment 2026-08-15

The mobile-facing requests shipped as `plugin.list`, `plugin.manifest`, `plugin.invoke`, `plugin.call`, and `plugins.invalidated` so the wire matches Herdr's plugin vocabulary. The design in this record is unchanged; treat earlier `extension.*` method names as the old name for those calls. The generic content mount is `/plugin` (Inbox is a plugin that uses it, not a shell tab).

## Amendment 2026-08-15 (primitives)

Native contributions name a **primitive** (`item-list`, `collection`, `icon-button`, `realtime-session-overlay`, …), never a plugin id. Boxed packages in `plugins/` are ordinary plugins that compose those widgets. Feature-named renderers (`muxr.attachments`, `muxr.inbox-content`, …) are removed. Attachments and changes list through `plugin.call`; the kernel does not push those catalogs onto the phone.

## Amendment 2026-08-15 (slots are the UI)

`muxr-ui.json` is the whole phone UI for a plugin: slot + primitive + parameters (`source`, `capability`, `title`). The phone translates that document. Heavy work is a host RPC or persistent stream adapter. Primitives are slot-agnostic and may repeat in one slot. `voice.session` resolves a provider-neutral `host.stream`; the phone knows only generic audio/control/state/transcript frames and compiled transport capabilities such as PCM streaming or WebRTC. Provider URLs, authentication, models, prompts, tools, codecs, and events remain backend plugin policy. `session.changes` / `session.attachments` events and the host ChangeTracker are gone.

## Reopen triggers

Reopen this T3 decision if store review rejects the declarative model, an extension can spoof trust-critical UI, browser grants execute host code, manifest mutation bypasses stale-hash rejection, an extension can target implicit desktop context, or real bundled migrations require arbitrary layout/code in the external schema.
