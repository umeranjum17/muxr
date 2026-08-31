# muxr ↔ Herdr plugin architecture review

**Date:** 2026-08-31
**Scope:** read-only investigation. No files changed in `/home/umer/herdr` or `/home/umer/pockit`.
**Sources:** `muxr plugin docs` output, `/home/umer/pockit/docs/PLUGINS.md`, `/home/umer/pockit/docs/decisions/0005-pi-like-extension-runtime.md`, `/home/umer/herdr/src` (read only), `/home/umer/pockit/plugins/*`, `/home/umer/pockit/apps/host/src`, `/home/umer/pockit/apps/mobile/sources`, live `herdr plugin list`.

---

## 0. Verdict up front

The owner's read is correct, and the cause is structural rather than lazy authoring.

There are **two disjoint plugin contracts in one folder**:

| | Herdr contract | muxr contract |
|---|---|---|
| File | `herdr-plugin.toml` | `muxr-ui.json` |
| Parsed by | `herdr/src/app/api/plugins/manifest.rs` | `pockit/apps/host/src/agent/infrastructure/pluginCatalog.ts` |
| Declares | commands to run | UI to render + RPCs to call |
| Execution | Herdr spawns, fire-and-forget, logged | muxr host spawns `node`, request/response |
| State dir | `~/.local/share/herdr/plugins/<id>` | `~/.muxr/plugin-state/<id>` |
| Sees the other file? | **No** — `grep -r "muxr-ui" /home/umer/herdr/src` returns nothing | Yes, `pluginCatalog.ts:19` `const MANIFEST_NAME = 'muxr-ui.json'` |

Herdr is used by muxr as a **registry and a trust decision**, not as an action runtime. The manifests look thin because *all* the muxr-relevant declaration lives in the sibling file, and because the Herdr behavioural surface (`[[actions]]`, `[[events]]`, `[[startup]]`, `[[link_handlers]]`) has **zero users among the 15 bundled plugins**.

Meanwhile `apps/host/src/agent/infrastructure/herdrSessionSource.ts` (2,926 lines) hard-codes the entire Herdr action surface natively — `agent.start`, `agent.prompt`, `pane.split`, `tab.create`, `workspace.create`, `worktree.create` — and exposes **none of it** to plugins.

The owner's model (Herdr owns actions, muxr renders a declarative mapping) is **not achievable on today's contract** without a change in Herdr, for one specific reason stated in §4.

---

## 1. What the Herdr plugin contract actually offers

### 1.1 Manifest fields — the complete list

From `RawPluginManifest`, `/home/umer/herdr/src/app/api/plugins/manifest.rs:12-33`:

| Field | Type | Notes |
|---|---|---|
| `id` | string, required | `normalize_plugin_id`, max 120 chars (`manifest.rs:8`) |
| `name` | string, required | |
| `version` | string, required | |
| `min_herdr_version` | string, **required** | semver; rejected if newer than running Herdr (`manifest.rs:222-256`) |
| `description` | string, optional | |
| `platforms` | `["linux"\|"macos"\|"windows"]` | omitted ⇒ warning `"manifest does not declare platforms"` (`manifest.rs:196`) |
| `[[build]]` | `{ platforms?, command[] }` | runs on `herdr plugin install`, not on `link` |
| `[[startup]]` | `{ platforms?, command[] }` | `plugin.startup` / `run_plugin_startup_hooks` (`runtime.rs:183`) |
| `[[actions]]` | `{ id, title, description?, contexts[], platforms?, command[] }` | duplicate ids rejected (`manifest.rs:317`) |
| `[[events]]` | `{ on, platforms?, command[] }` | unknown `on` ⇒ non-fatal warning (`manifest.rs:328-336`) |
| `[[panes]]` | `{ id, title, description?, platforms?, placement, width?, height?, command[] }` | `width`/`height` only valid with `placement = "popup"` (`manifest.rs:415-422`) |
| `[[link_handlers]]` | `{ id, title, pattern, action, platforms? }` | `action` must name a declared action (`manifest.rs:361-378`) |

That is **12 fields, 6 of them behavioural**. There is no UI field of any kind. Herdr cannot describe a screen, a row, a chart, or a button.

### 1.2 Action contexts

`PluginActionContext`, `/home/umer/herdr/src/api/schema/plugins.rs:355`:
`global`, `workspace`, `tab`, `pane`, `selection`.

### 1.3 Pane placements

`PluginPanePlacement`, `plugins.rs:445`: `overlay` (default), `popup`, `split`, `tab`, `zoomed`.

### 1.4 Event hooks — the 22 hookable events

`PLUGIN_HOOK_EVENT_KINDS`, `/home/umer/herdr/src/api/schema/events.rs:286-309`:

```
workspace.created  workspace.updated  workspace.closed  workspace.renamed
workspace.moved    workspace.reordered  workspace.focused
worktree.created   worktree.opened    worktree.removed
tab.created        tab.closed         tab.renamed      tab.moved      tab.focused
pane.created       pane.closed        pane.focused     pane.moved     pane.exited
pane.agent_detected  pane.agent_status_changed
```

Deliberately excluded as high-volume (`events.rs:349-360`): `pane.output_changed`, `layout.updated`, `workspace.metadata_updated`, `pane.updated`.

### 1.5 What an action/event/pane process actually receives

`/home/umer/herdr/src/app/api/plugins/runtime.rs:38-80` — environment, **no stdin**:

```
HERDR_PLUGIN_ROOT   HERDR_PLUGIN_CONFIG_DIR   HERDR_PLUGIN_STATE_DIR
HERDR_SOCKET_PATH   HERDR_BIN_PATH   HERDR_ENV=1
HERDR_PLUGIN_ID     HERDR_PLUGIN_CONTEXT_JSON
HERDR_PLUGIN_ACTION_ID | HERDR_PLUGIN_EVENT + HERDR_PLUGIN_EVENT_JSON
HERDR_WORKSPACE_ID  HERDR_TAB_ID  HERDR_PANE_ID
HERDR_PLUGIN_CLICKED_URL   HERDR_PLUGIN_LINK_HANDLER_ID
```

`HERDR_PLUGIN_CONTEXT_JSON` is `PluginInvocationContext` (`plugins.rs:363-393`): `workspace_id`, `workspace_label`, `workspace_cwd`, `worktree`, `tab_id`, `tab_label`, `focused_pane_id`, `focused_pane_cwd`, `focused_pane_agent`, `focused_pane_status`, `selected_text`, `invocation_source`, `correlation_id`, `clicked_url`, `link_handler_id`.

**The critical property:** Herdr hands the child `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH`. A Herdr plugin action is a first-class Herdr client and can drive the whole socket API.

### 1.6 Herdr plugin RPC surface (socket)

`plugin.link`, `plugin.list`, `plugin.unlink`, `plugin.enable`, `plugin.disable`, `plugin.startup`, `plugin.action.list`, `plugin.action.invoke`, `plugin.log.list`, `plugin.pane.open`, `plugin.pane.focus`, `plugin.pane.close`.

### 1.7 The full Herdr action surface a plugin could drive

Extracted from `/home/umer/herdr/src/api/*.rs` — 90+ methods:

```
agent.start  agent.prompt  agent.send_keys  agent.read  agent.wait  agent.list
agent.get    agent.focus   agent.rename     agent.explain  agent.view.set/clear
pane.split   pane.close    pane.focus       pane.focus_direction  pane.move  pane.swap
pane.zoom    pane.resize   pane.rename      pane.read   pane.send_text/input/keys
pane.wait_for_output  pane.list  pane.get  pane.current  pane.layout  pane.edges
pane.neighbor  pane.process_info  pane.report_agent/_session/_metadata
pane.release_agent  pane.clear_agent_authority  pane.graphics.*
tab.create   tab.close     tab.focus  tab.rename  tab.move  tab.list  tab.get
workspace.create/close/focus/rename/move/move_block/list/get/report_metadata
worktree.create/list/open/remove
layout.apply  layout.export  layout.set_split_ratio
session.snapshot  events.subscribe  events.wait  notification.show  popup.close
server.reload_config  server.stop  server.live_handoff  integration.install/uninstall
client.window_title.set/clear
```

### 1.8 The hard limit: Herdr actions are fire-and-forget

`start_plugin_command`, `runtime.rs:104-180`, pushes a `PluginCommandLogInfo` with `status: Running` and **returns immediately** (`Ok(log)` at `:180`). The child runs on a detached thread; stdout is capped at 64 KiB (`PLUGIN_COMMAND_OUTPUT_MAX_BYTES`, `:11`) and written to the log later, retrievable only via `plugin.log.list` by polling. There is **no stdin, no typed input, no synchronous result, no schema**.

Global cap: 32 concurrent plugin commands (`MAX_PLUGIN_COMMANDS_IN_FLIGHT`, `:12`); 200-entry rolling log (`:13`).

**This is why muxr built `host.rpc`.** Herdr's contract can fire an action but cannot answer a question, so it cannot back a UI that needs data.

### 1.9 Permissions, sandboxing

None. `plugin_command.rs:7` `command_for_argv_in_dir` spawns with `current_dir(plugin_root)` and the inherited environment plus the vars above. Enabling a plugin is the entire trust model, stated plainly in `docs/PLUGINS.md` §Trust and `0005-pi-like-extension-runtime.md:146`.

---

## 2. What muxr's contract adds on top (`muxr-ui.json`)

Not part of Herdr. Read by `apps/host/src/agent/infrastructure/pluginCatalog.ts:19`.

- **18 slots** (`docs/PLUGINS.md` §Hooks): `events`, `shortcuts`, `host.rpc`, `host.stream`, `navigation.primary`, `navigation.content`, `home.cards`, `session.header.trailing`, `session.pills`, `session.toolbar`, `terminal.key-row`, `settings.items`, `settings.sections`, `app.overlay`, `session.overlay`, `home.composer.leading`, `home.composer.trailing`, `session.composer.trailing`.
- **6 primitives**: `item-list`, `collection`, `icon-button`, `realtime-session-overlay`, `tree-sheet`, `dictate`.
- **2 phone capabilities** (`apps/mobile/sources/plugins/application/capabilityRegistry.ts:22-28`): `speech.wake`, `voice.start`. That is the entire compiled effect registry.
- **`host.rpc`**: request/response, stdin JSON in, 64 KiB stdout out, `read`/`write` modes, idempotency fencing, 30 s deadline.
- **`host.stream`**: persistent NDJSON child.
- Declared public context: `"sessions"` and `"workspace-tree"` only.
- Child env (`pluginCatalog.ts:485-496`): `PATH HOME MUXR_HOME MUXR_PLUGIN_ID MUXR_PLUGIN_STATE_DIR` + optional `MUXR_PLUGIN_CONTEXT_JSON`. **No `HERDR_SOCKET_PATH`, no `HERDR_BIN_PATH`.**

---

## 3. What the bundled plugins actually use

### 3.1 Herdr-side usage — the headline number

Across all 15 bundled plugins in `/home/umer/pockit/plugins`:

| Herdr field | Plugins using it |
|---|---|
| `id` / `name` / `version` / `min_herdr_version` / `description` / `platforms` | 15 / 15 |
| `[[panes]]` | **2** — `control` (6 panes), `voice` (1 pane) |
| `[[actions]]` | **0** |
| `[[events]]` | **0** |
| `[[startup]]` | **0** |
| `[[build]]` | **0** |
| `[[link_handlers]]` | **0** |

Thirteen of fifteen `herdr-plugin.toml` files are *exactly* six identity lines. That is not an impression — it is the literal file. Example, `plugins/status/herdr-plugin.toml` in full:

```toml
id = "muxr.status"
name = "Status"
version = "0.1.0"
min_herdr_version = "0.8.0"
platforms = ["linux", "macos"]
description = "Coding-agent usage and machine vitals"
```

…backed by a 429-line `usage.mjs` and a 14-line `vitals.mjs` that Herdr never sees, never spawns, and never logs.

**Contrast — third-party Herdr plugins installed on this machine do use the contract:**

- `~/.herdr-plugins/animal-namer/herdr-plugin.toml`: three `[[events]]` hooks on `pane.agent_detected`, `pane.agent_status_changed`, `pane.focused`.
- `herdr-plugin-renamer`: two `[[build]]` steps and an `[[events]]` hook on `pane.agent_status_changed`.

So the Herdr contract is not unused in the wild. It is unused **by muxr**.

### 3.2 Per-plugin capability matrix

| Plugin | Herdr contract used | muxr slots used | Backend |
|---|---|---|---|
| `attachments` | identity only | `host.rpc`(1 read), `session.pills`/`item-list` | `rpc.mjs` 82 |
| `code` | identity only | `host.rpc`(8: 7 read/1 write), `navigation.primary`×2, `navigation.content`×6, `session.header.trailing`×2, `session.pills` | 390 lines across 4 `.mjs` |
| `control` | **`[[panes]]`×6** | *(no `muxr-ui.json` at all)* | `run.mjs` 31 |
| `dictation` | identity only | 2 composer primitives | none |
| `example-ui` | identity only | `host.rpc`×2, `navigation.content`, `capabilities` | `rpc.mjs` 41 |
| `inbox` | identity only | `navigation.primary`, `navigation.content`/`collection`, `host.rpc`×2 | `rpc.mjs` 112 |
| `servers` | identity only | `host.rpc`×4, `navigation.primary`, `navigation.content`×2, `session.header.trailing`/`item-list` | 227 lines |
| `status` | identity only | `host.rpc`×2, `navigation.primary`, `session.header.trailing`, `navigation.content`, `home.cards` | 443 lines |
| `terminal-keys` | identity only | `terminal.key-row` | none |
| `voice` | **`[[panes]]`×1** | `host.rpc`×4, `host.stream`, `app.overlay`, 2 composer primitives, `settings.items`, `navigation.content`, `events`, `shortcuts`, `capabilities`×4 | 1,183 lines (+798 spec) |
| `voice-gemini` / `voice-openai` / `voice-codex` | identity only | same shape as `voice` minus `shortcuts` | 300–470 lines each |
| `workspace-hierarchy` | identity only | `session.overlay`/`tree-sheet`, `host.rpc`×2, `capabilities: agent.close` | 359 lines |

### 3.3 muxr slots with zero bundled users

- **`session.toolbar`** — the *only* slot that reaches a Herdr action (`docs/PLUGINS.md` §"Add a backend action"). Fully implemented end to end: `pluginCatalog.ts:294`, `useSessionPlugins.ts:15`, `TerminalScreen.tsx:838`, `herdrSessionSource.ts:2084-2106` → `plugin.action.invoke`. **Not used by a single bundled plugin.** The one bridge between the two systems ships dead.
- **`settings.sections`** — zero users.

---

## 4. Concrete gaps

### Gap 1 — muxr runs a second executable plugin runtime, contradicting its own ADR

`docs/decisions/0005-pi-like-extension-runtime.md:54` states:

> "Herdr remains the sole backend plugin registry/runtime. muxr does not create a second executable plugin system."

But `apps/host/src/agent/infrastructure/pluginCatalog.ts:482`:

```ts
const child = spawn(process.execPath, [options.script, options.method], { … })
```

and `apps/host/src/agent/infrastructure/pluginStreamManager.ts:166`:

```ts
child = spawn(process.execPath, [join(params.target.pluginRoot, params.target.entry)], { … })
```

Every `host.rpc` and `host.stream` child is spawned **by the muxr host, not by Herdr**. Consequences, each verifiable:

- These processes never appear in `plugin.log.list`.
- They do not count against Herdr's `MAX_PLUGIN_COMMANDS_IN_FLIGHT = 32`; muxr re-implements admission control (`MAX_RPC_PER_PLUGIN`, `MAX_RPC_PER_DEVICE`, `pluginCallConcurrency`).
- They get `MUXR_PLUGIN_STATE_DIR = ~/.muxr/plugin-state/<id>` while Herdr independently creates `~/.local/share/herdr/plugins/<id>` and `~/.config/herdr/plugins/config/<id>` for the same plugin — three state directories, one plugin, no shared convention.
- Timeout, kill-grace, process-group teardown, and idempotency are re-implemented in TypeScript alongside Herdr's Rust equivalents.

The ADR is not wrong about intent; the implementation drifted past it. It should either be honoured or amended.

### Gap 2 — plugins cannot reach Herdr through the contract, so they bypass it

Only one RPC in the entire system is granted a Herdr socket, and it is hard-pinned:

`herdrSessionSource.ts:2750` passes `trustedHerdrSocketPath: socketPath` for exactly one call — the `muxr.workspace-hierarchy` `close` RPC, validated against a fixed manifest tuple (`docs/PLUGINS.md` §"Packaged Agent close policy"). Everything else gets nothing.

So the plugins that need Herdr go around it:

- `plugins/code/files.mjs:10` — `const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';`
  `HERDR_BIN_PATH` is **never set** by `runPluginProcess` (`pluginCatalog.ts:485-496`), so this always resolves to a bare `herdr` on `PATH`, shelling out at `:14-15` for `workspace list` / `pane list`.
- `plugins/code/runbook.mjs:29-30` — same shell-out.
- `plugins/workspace-hierarchy/close.mjs:200-202` — falls back through `MUXR_HERDR_SOCKET_PATH` → `HERDR_SOCKET_PATH` → a **guessed** `join(homedir(), '.config', 'herdr', 'herdr.sock')`, then hand-rolls a 45-line JSON-RPC client over the raw unix socket (`:196-245`).

A third-party plugin cannot do either of these safely. There is no supported way for a muxr plugin to ask Herdr for anything.

### Gap 3 — the native app owns every real action

`packages/contract/src/control-plane/domain/requests.ts` defines **68 request types**. The Herdr-backed ones are all implemented natively in `herdrSessionSource.ts`:

| muxr request (native) | Herdr call it wraps | herdrSessionSource.ts |
|---|---|---|
| `session.start` | `agent.start` | `:1254` |
| `session.prompt` | `agent.prompt` | `:242` |
| `session.answer` | `agent.send_keys` | `:234` |
| `session.stop` | `pane.close` / `tab.close` / `workspace.close` | `:348`, `:378`, `:402` |
| `pane.close` / `pane.focus` / `pane.read` | same | `:1670`, `:1784`, `:1752` |
| `tab.create` | `tab.create` | `:1622` |
| `worktree.land` | `worktree.create` | `:1586` |
| `herdr.tree` | `session.snapshot` | `:1176` |
| `layout.apply` / `layout.export` | same | — |
| `voice.provider.select` | `plugin.enable` / `plugin.disable` | `:1837-1848` |

None of these are expressible as a plugin. The session action menu is likewise hard-coded — `apps/mobile/sources/herd/application/useSessionQuickActions.ts:190-204` builds `details`, `resume`, `fork`, `duplicate`, `copy-metadata`, `copy-metadata-and-logs` as literal array pushes. Adding "rename this workspace" or "open a split" requires an app release, even though Herdr has `workspace.rename` and `pane.split` today.

### Gap 4 — the same data is served twice, two different ways

The workspace tree exists as:

1. a native request `herdr.tree` (`sync.ts:498`, consumed by `grid/[tabId].tsx:27`, `workspace/[id].tsx:30`, `new-agent.tsx:257`, `realtimeSessionState.ts:113`), backed by Herdr `session.snapshot`;
2. a plugin RPC `muxr.workspace-hierarchy` → `tree`, built from `MUXR_PLUGIN_CONTEXT_JSON.workspaces` (`plugins/workspace-hierarchy/rpc.mjs:16-23`), rendered only into the `session.overlay` tree-sheet.

Two code paths, two shapes, two failure modes, one concept.

### Gap 5 — `muxr.control` is the honest counter-example, and it is phone-invisible

`plugins/control/herdr-plugin.toml` declares 6 `[[panes]]` (setup, pair, devices, doctor, service, selfhost) and ships **no `muxr-ui.json`**. It is a genuine Herdr plugin. It contributes nothing to the phone, because Herdr panes are a desktop-terminal concept with no muxr slot. The two contracts do not overlap even where a plugin uses one properly.

### Gap 6 — muxr consumes 12 of Herdr's ~100 socket methods and none of its plugin extension points

`grep` of `apps/host/src` for Herdr method strings finds ~25 distinct calls. `plugin.action.list`, `plugin.log.list`, `plugin.pane.open`, `plugin.pane.focus`, `plugin.pane.close`, and `plugin.startup` are referenced nowhere in muxr (only the type `link_handlers` appears, as an opaque `unknown[]` used solely for the authority digest at `pluginCatalog.ts:359` and `scripts/plugin/application/installPlugin.mjs:66`).

---

## 5. Is the owner's model achievable today?

**Statement of the model:** Herdr owns all actions; the muxr React Native app is a declarative UI mapping over them; `muxr-ui.json` maps UI to Herdr actions.

### Short answer

**Writes: yes, today. Reads: only through a poll, and not worth it for most of them.**

> **Amended 2026-08-31.** The first draft called this outright unachievable. That was too strong. `plugin.action.invoke` returns `{ action, context, log }` carrying a `log_id` (`herdr/src/app/api/plugins/mod.rs:216-221`), and `plugin.log.list` later returns that entry with `exit_code`, `stdout` (64 KiB cap) and `stderr`; Herdr's own test polls exactly this way (`mod.rs:2297-2320`). A request/response shape *is* reconstructable host-side without changing Herdr. What remains true is that it is a poll, not a call.

### The real constraint

**Herdr actions do not return data to their caller, and no event announces completion.** `runtime.rs:104-180` starts the process and returns a `Running` log immediately; `src/app/actions.rs:2939` maps the internal `PluginCommandFinished` to an empty list of public envelopes, so nothing reaches `events.subscribe`. Recovering an outcome means polling `plugin.log.list`, with no stdin, no typed input and no schema.

That is fine for **writes**, where the state change is the answer: an action that splits a pane makes Herdr emit `pane.created` and `layout.updated`, which muxr already subscribes to (`herdrSessionSource.ts:457-469`). It is a poor fit for **reads**, where a UI needs `list the files` → `[…]` in one bounded round trip against a 200-entry rolling log (`runtime.rs:13`) and a 32-command global cap (`:12`).

Every screen, card, pill, chart, tree, collection and badge in muxr's contract depends on `host.rpc`. Route those through `plugin.action.invoke` and the entire read side of the UI stops working. `host.rpc` is not duplication for its own sake — it exists because the Herdr contract has a hole exactly where muxr needs it.

### What *is* achievable today, unchanged

The **write/command half** of the model already works and is simply unused:

- `session.toolbar` + `{"type":"plugin.invoke","actionId":"…"}` → `plugin.action.invoke` with muxr-resolved `focused_pane_id`, `focused_pane_cwd`, `workspace_id`, `tab_id` (`herdrSessionSource.ts:2084-2106`).
- The action child gets `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH`, so it can drive `pane.split`, `workspace.rename`, `agent.start`, `worktree.create` — the full surface in §1.7.
- Herdr enforces authority; muxr re-validates the plugin is enabled and the action id exists before every invoke (`:2088-2090`).

So a bundled plugin could ship today with:

```toml
[[actions]]
id = "split-right"
title = "Split right"
contexts = ["pane"]
command = ["node", "./split.mjs"]
```

```json
{ "slot": "session.toolbar", "id": "split", "type": "button", "label": "Split",
  "action": { "type": "plugin.invoke", "actionId": "split-right" } }
```

…and `split.mjs` would call `herdr pane split` using `HERDR_PANE_ID` from its own environment. Zero app changes, zero Herdr changes. **Nobody has written that plugin.** That is the cheapest possible proof the ecosystem is one thing, and it is a two-file, ~20-line demonstration.

### What is missing to reach the full model

| # | Missing piece | Where it must land | Cost |
|---|---|---|---|
| 1 | **Request/response actions in Herdr** — stdin JSON in, bounded JSON stdout out, awaited result, plus a completion event so callers need not poll | Herdr (`runtime.rs`, `plugins.rs`, `events.rs`) — additive, beside the existing fire-and-forget path | Large, and Herdr's call to make. Not a blocker for writes; only reads need it. |
| 2 | **A sanctioned Herdr client for plugin children** — pass `HERDR_SOCKET_PATH`/`HERDR_BIN_PATH` to `host.rpc`/`host.stream` children instead of the single pinned `close` exception | muxr host, `pluginCatalog.ts:485-496` | Small code, **large security decision**: it hands every enabled plugin the full Herdr action surface. Needs a per-plugin declared-capability gate, which does not exist. |
| 3 | **`kernel.action` in the action vocabulary** — let a manifest name a first-party Herdr action (`pane.split`, `workspace.rename`) directly, without a per-plugin `.mjs` shim | muxr contract + app | Medium. Needs an allow-list of safe Herdr methods and their parameter shapes, plus context binding. This is the literal "map muxr UI JSON to Herdr actions" the owner described. |
| 4 | **A Herdr pane slot on the phone** — so `[[panes]]` reaches muxr instead of being desktop-only | muxr app + contract | Medium–large. `plugin.pane.open` exists in Herdr (`plugins.rs:410-437`) with placement, cwd and env; muxr never calls it. |
| 5 | **`settings.sections` / `session.toolbar` actually used by bundled plugins** | `plugins/*` | Trivial. |
| 6 | **Delete one of the two workspace-tree paths** | muxr | Small. |

### Honest cost assessment

- **Items 5 and 6, plus the `session.toolbar` demo plugin: days.** They make muxr and Herdr *look and feel* like one ecosystem, close Gap 4 and Gap 5, and cost nothing architecturally. This is where the leverage is.
- **Item 3 without item 1: weeks.** A `kernel.action` type that drives write-only Herdr methods (split, rename, focus, close, start) is fully achievable today, because writes do not need a return value. This delivers most of the owner's stated model.
- **Item 1: a Herdr feature request.** Until Herdr can answer a call, `host.rpc` must stay. Retiring `host.rpc` is not a muxr decision.
- **Item 2: do not do it without a capability gate.** Handing arbitrary enabled plugins `HERDR_SOCKET_PATH` grants full workspace control to any package the user enabled. The existing pinned-tuple pattern for `agent.close` is the right precedent to generalise, not to abandon.

### Bottom line for the owner

The model is right and half of it is already built — the `plugin.invoke` → `plugin.action.invoke` bridge is complete, tested (`pluginCatalog.test.ts:175`) and shipping unused. The manifests read thin because muxr never wrote a plugin that uses the Herdr half of its own contract.

The unreachable half is reads, and the reason is a genuine hole in Herdr's action contract, not a muxr shortcut. `host.rpc` is justified. What is *not* justified is that thirteen bundled plugins declare nothing to Herdr at all, that the one bridge slot has zero users, and that plugins that need Herdr shell out to a bare `herdr` on `PATH` or guess at a socket path in `$HOME`.

---

## 6. What was changed (2026-08-31)

Branch `feat/plugin-herdr-actions`. The report above describes the state before these changes.

**Bundled plugins: 14 → 8.** Deleted `example-ui` (an SDK sample that shipped enabled, putting a dummy screen in the real app), `servers` (Preview is already reachable from the terminal port chip, `useTerminalChipLink.ts:43`), and `inbox` (Recent Activity renders the same done/blocked/waiting states, `RecentActivity.tsx:41-44`). Folded `voice-gemini`, `voice-openai` and `voice-codex` into `plugins/voice/providers/*.mjs`; they were never standalone packages, each importing `../voice/coordinatorPolicy.mjs` from a sibling plugin's folder.

**Retirement map deleted.** `RETIRED` in `scripts/plugin/domain/pluginId.ts` listed one hand-maintained entry per historical rename. Replaced by a rule with no table: a registration pointing directly into our bundle directory that no longer names a shipped plugin is unlinked on setup. Covers every past and future removal; anything the user linked from elsewhere is untouched.

**Provider selection moved into the plugin.** `voice.provider.list`/`voice.provider.select` host requests, `voiceProviderOptions`, `selectVoiceProviderNow`, the `voiceSwitch` serialization and `capabilityPlugins` are gone (~75 lines). The phone calls the plugin's capability through the existing `callPlugin` path. The view-only security property is preserved by a stricter general rule: `plugin.call` admits a view-only device only for `mode: "read"` (`createRequestDispatcher.ts:256-258`), so the write-mode `voice.provider.set` is refused.

**Gap 3, partially closed.** `plugin.action.invoke` now reports failures: the host reads the returned `log_id` and polls `plugin.log.list`, turning a non-zero exit into an error the phone shows, and treating an action still running after five seconds as started. `muxr.control` is the first bundled user of `session.toolbar` → `plugin.action.invoke`, contributing Split right / Split down with **no backend script at all** — `HERDR_PANE_ID` is exported to action processes (`runtime.rs:69-71`) and `herdr pane split --current` reads it (`cli/pane.rs:542,585`). `docs/PLUGINS.md` had documented the opposite, which is plausibly why no bundled plugin ever declared an action.

**Gap 2, closed for `code`.** `files.mjs` and `runbook.mjs` no longer shell out to a bare `herdr` on `PATH`; they declare `context: ["sessions"]` and read the host's sanitized snapshot, which already carries every session `cwd`. Two subprocesses per call removed, and no dependency on a binary the plugin was never handed. `workspace-hierarchy/close.mjs` no longer falls back to a guessed `~/.config/herdr/herdr.sock`; a missing host-supplied socket is now an error rather than a different Herdr.

**Honest scope corrections.** Two items from the original plan were dropped after checking them:

- *`status/vitals` was to move onto a Herdr action.* It should not. Memory, load and disk are machine facts Herdr has no API for; routing them through an action would spawn the same process and add poll latency. It stays a `host.rpc` and instead lost its `df` subprocess in favour of `fs.statfs`.
- *`workspace-hierarchy/tree` reshapes context the host already holds.* Eliminating that process needs a new manifest source kind that renders declared context without an RPC. That is a contract feature, not a plugin fix, and it is not worth more than the ~50 ms it saves. Deferred.

**Plugin list segregation.** `hasBackend` was one boolean OR-ing two different worlds, so a package Herdr merely registers still read as a Herdr plugin. Split into `herdrBackend` (Herdr declares actions/events/panes/startup/build/links) and the existing `hasBackend` (runs code at all). Settings → Plugins now groups **Herdr + muxr**, **muxr only**, and **Herdr only**.

**ccusage flakiness.** Four fixes in `plugins/status/usage.mjs`: the reported week is now anchored to today and days are placed by date, so ccusage omitting an idle today can no longer present an older day's totals as current; the worst-case runtime dropped from ~28 s to ~15 s against the 30 s host deadline; a failed read is no longer cached for a minute; and a fallback provider is no longer cached under the requested provider's key.

**Stale registrations.** `muxr doctor` now reports registered plugins whose files are gone, with a one-tap unlink. `muxr plugin dev` against a temp directory used to leave a permanent entry that rotted into an "Unavailable" row on every connected phone.
