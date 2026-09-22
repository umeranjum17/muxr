# Build a muxr plugin

muxr plugins are designed to be small. The target workflow is to install one folder on the computer running Herdr and have its enabled native UI appear in muxr.

One artifact, two tools: a muxr plugin *is* a Herdr plugin. `herdr plugin` runs it on your computer; `muxr plugin` authors it and manages how it appears on your phone. There is no separate muxr package format.

This guide and the authoring skill ship inside the npm package. A human or coding agent can locate both without the repository or web access:

```bash
muxr plugin docs
```

A plugin can be:

- **backend-only:** Herdr actions, panes, startup, or event hooks;
- **UI-only:** cards, settings, status, terminal keys, notification presentation, or screens;
- **combined:** a Herdr capability and the muxr UI that controls it.

If you have built a Pi extension, the workflow should feel familiar. The important mobile difference is that external extensions compose muxr's native components instead of downloading React or JavaScript into the app.

> **Status:** protocol v1 ships the immutable catalog, explicit disable/revoke, static `settings.sections`, context-bound `session.toolbar` actions, manifest-declared `host.rpc`/`host.stream`, typed native slots, declarative terminal key rows, navigation/settings items, data cards, and declarative `navigation.content` screens. Native slots compose compiled **primitives** through a validated compatibility table. Enabling a Herdr plugin is the trust decision; enabled plugins appear on connected phones by default. The broader hook table remains under [`decisions/0005-pi-like-extension-runtime.md`](decisions/0005-pi-like-extension-runtime.md).

## Smallest extension

```text
hello-muxr/
├── herdr-plugin.toml
├── muxr-ui.json
└── README.md
```

`herdr-plugin.toml` gives the package an identity. muxr intentionally accepts only a strict simple subset for this field: one top-level bare `id = "..."` assignment matching the documented id pattern. Literal-string ids, quoted keys, and triple-quoted multiline strings are unsupported (the rest of the TOML is parsed by Herdr).

```toml
id = "you.hello-muxr"
name = "Hello muxr"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "A UI-only muxr plugin"
platforms = ["linux", "macos"]
```

`muxr-ui.json` contributes native UI:

```json
{
  "schemaVersion": 1,
  "pluginId": "you.hello-muxr",
  "contributions": [
    {
      "slot": "settings.sections",
      "id": "hello",
      "title": "Hello muxr",
      "children": [
        {
          "type": "row",
          "title": "It works",
          "subtitle": "This row came from an extension installed on your computer."
        }
      ]
    }
  ]
}
```

Link it with Herdr:

```bash
herdr plugin link ./hello-muxr --enabled
```

An enabled Herdr plugin appears in muxr automatically. Open **Settings → Plugins** to inspect its contributions or disable it on that phone. Editing `muxr-ui.json` refreshes the contribution snapshot; it does not ask for approval again.

## Package lifecycle

Package management keeps Herdr as the only executable registry and runtime:

```bash
muxr plugin docs
muxr plugin create hello-muxr
muxr plugin check ./hello-muxr
muxr plugin dev ./hello-muxr
muxr plugin list
muxr plugin install ./hello-muxr [--yes]
muxr plugin install owner/repo[/subdir][@ref] [--yes]
muxr plugin install npm:@scope/name@1.2.3 [--yes]
muxr plugin update npm:@scope/name@1.2.4 [--yes]
muxr plugin remove you.hello-muxr [--yes]
```

Local and npm packages are linked disabled, shown with Herdr's parsed authority, and enabled only after confirmation. npm packages use `npm pack --ignore-scripts` at an exact registry version, reject dependencies, links, special archive entries, and unsafe paths, and are materialized under `$MUXR_HOME/extensions/<id>`. Their nofollow provenance is kept outside the package at `$MUXR_HOME/extensions/.provenance/<id>.json`; the package name, exact version, integrity, root, and extension id are included in the approval source identity. This provenance is CLI management metadata, not a trust boundary against the same unsandboxed host user, who can modify it. No lifecycle scripts, dependency installs, or downloaded mobile code run.

GitHub installs are delegated to Herdr's Git installer. A supplied `@ref` is passed unchanged, Herdr records the resolved commit in the plugin source shown before enablement, and muxr serializes concurrent lifecycle operations. Unlike the npm path, muxr does not independently verify an archive integrity value or inspect a dependency graph for Git sources. Pin a commit ref when reproducibility matters; enabling the linked code is the trust decision.

## Add a backend action

Add an ordinary Herdr action:

```toml
[[actions]]
id = "say-hello"
title = "Say hello"
contexts = ["pane"]
command = ["node", "./say-hello.mjs"]
```

Reference it from the UI:

```json
{
  "slot": "session.toolbar",
  "id": "say-hello",
  "type": "button",
  "label": "Hello",
  "action": {
    "type": "plugin.invoke",
    "actionId": "say-hello"
  }
}
```

muxr never executes a command from the UI document. It sends the enabled extension ID, manifest hash, declared action ID, and explicit session context to the host. The host verifies them and asks Herdr to invoke the action from that same package.

Your action receives `HERDR_PLUGIN_CONTEXT_JSON`, including the muxr-resolved `focused_pane_id`, `focused_pane_cwd`, `workspace_id`, `tab_id`, and `invocation_source`. Herdr also exports `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` from that same context, and puts the `herdr` binary on `HERDR_BIN_PATH`. The launcher re-exports the selected host socket from `MUXR_HERDR_SOCKET_PATH` as `HERDR_SOCKET_PATH` and inherits `MUXR_HOME`. Write state under `HERDR_PLUGIN_STATE_DIR`.

Because `HERDR_PANE_ID` is the session the phone is looking at, an action that only drives Herdr needs no script of its own:

```toml
[[actions]]
id = "split-right"
title = "Split right"
contexts = ["pane"]
command = ["herdr", "pane", "split", "--current", "--direction", "right"]
```

Herdr starts an action and returns before it finishes, and publishes no completion event. muxr watches the action's log briefly and surfaces a non-zero exit as an error on the phone; an action still running after that window is reported as started, and its effects arrive as ordinary Herdr events. Actions are therefore for driving Herdr, not for returning data — use `host.rpc` when the phone needs an answer.

## Hooks

Hooks are stable native slots. They are not DOM selectors and cannot replace trust-critical screens.

Every slot below is shipped. **JSON** means you edit `muxr-ui.json` and the change appears within about two seconds, no app rebuild. **Primitive** means the surface needs a compiled widget already in the app; you name it in `primitive` and the plugin's backend fills it.

| Slot | What you contribute | How |
|---|---|---|
| `events` | a trigger: when app state changes, run a kernel action | JSON |
| `shortcuts` | an Android launcher shortcut | JSON; bundled entries require an app rebuild |
| `host.rpc` | a bounded one-shot backend entrypoint | JSON + `.mjs` |
| `host.stream` | a persistent provider adapter over bounded NDJSON frames | `.mjs` |
| `navigation.primary` | a navigation destination; product chrome decides where it renders (home chips, sidebar tools) and in what order | JSON (`navigation-item`) |
| `navigation.content` | the screen that destination opens | JSON (`screen`) or primitive |
| `home.cards` | a Home card, or `"presentation": "sheet"` for a pill that opens a bottom sheet; a card may set `contentContributionId` to open a declared `navigation.content` screen. The Right-now card is host product code fed by the `usage.now` request, not a plugin contribution: the retired `"product": "right-now"` data-card marker is ignored, and every `home.cards` contribution keeps the generic data card | JSON (`data-card`) |
| `session.header.trailing` | a session action; the pane menu renders it as a row | JSON (`data-card` or `screen-button`) or primitive |
| `session.pills` | a session action; the pane menu renders it as a row | JSON (`data-card`) or primitive |
| `session.toolbar` | a pane-menu command that runs a declared Herdr action | JSON (`button`) |
| `terminal.key-row` | terminal keys | JSON (`key-row`) |
| `settings.items` | a row in Settings that opens your screen | JSON (`settings-item`) |
| `settings.sections` | static information rows in Settings | JSON |
| `app.overlay` | an app-wide overlay | primitive |
| `session.overlay` | a session-scoped sheet | primitive |
| `home.composer.leading` / `home.composer.trailing` | buttons beside the home prompt | primitive |
| `session.composer.trailing` | a session action rendered in the header's three-dot pane menu, not the composer rail | primitive |

Primitive slots are animated, stateful, or OS-bridging surfaces. The app ships named widgets and validates each widget's allowed slots, required context, and bounded `params`. Unknown primitive names are ignored for forward compatibility; known primitives reject wrong slots, missing or unknown parameters, and invalid values.

| Primitive | Allowed slots | Required context | Parameters |
|---|---|---|---|
| `item-list` | `home.cards`, `navigation.content`, `session.header.trailing`, `session.pills` | none | required read `source`; optional `title`, `icon`, `accessibilityLabel`, and `refreshIntervalMs` (5,000–300,000) |
| `collection` | `navigation.content` | none | required read `source`; optional `title`, `emptyTitle`, `emptyMessage`, `icon` |
| `icon-button` | home/session composer slots and `session.header.trailing` | none | required `capability`, `icon`, and `accessibilityLabel`; optional `indicator: "realtime-session"` |
| `realtime-session-overlay` | `app.overlay` | none | none |
| `tree-sheet` | `session.overlay` | `sessionId`, `visible`, `onClose`, `openMenu` | required read `source`; optional `title` |
| `dictate` | home and session composer trailing | `getText`, `setText` | none |

Declaring `realtime-session-overlay` records that a capability needs the product's voice surface; the product mounts that overlay itself, so the declaration paints nothing.

Primitive parameters live under `params`. An `item-list` with `refreshIntervalMs` refreshes only while its screen and the app are active, stops its timer when unfocused/unmounted, and always force-refreshes when the user opens it. Returning zero items hides the control.

Session actions appear under the header's three-dot pane menu. A session `screen-button`, or an `item-list`/`icon-button` native contribution in a supported session action slot, may set `"quickAction": true` on the contribution (not inside `params`). The flag stays accepted; its panel target is gone, and the floating terminal control that replaced it is product code that reads no plugin contributions, so quick and non-quick actions alike render as pane-menu rows — every declared action remains reachable there.

```json
{ "slot": "session.pills", "id": "files", "type": "native", "primitive": "item-list",
  "params": { "title": "Files", "icon": "attach-outline",
    "source": { "type": "plugin.call", "contributionId": "list" } } }
```

Its read RPC returns up to 50 rows. Each row has a unique `id` (255 UTF-8 bytes), `title` (255), optional `subtitle` (512), optional Ionicon `icon` (64-character identifier), optional `group` (40 bytes; rows sharing a group render as one titled section in first-seen order), optional `progress` (`{ "value": 0..1, "tone": ... }`, rendered as a thin fill bar under the row), up to three compact `metadata` entries (`label` and `value`, 40 bytes each, optional `tone` — the first entry renders as the row's emphasized figure), and an optional validated `action`; rows without one render read-only. A response may also include up to four sheet-level `actions`, each with unique `id`, `label` (40 bytes), optional `icon`, and a validated action, plus an optional `badge` (`{ "value": string (12 bytes), "tone": ... }`) that replaces the row count in the collapsed pill with one glanceable figure. Set `minMuxrVersion: 8` when sheet-level actions are essential; older phones safely ignore optional response fields. The phone bounds and sanitizes every value, drops duplicate ids, and discards malformed metadata or invalid actions. Returning no rows and no sheet actions hides the control. This is generic presentation data: a git plugin may return `+12` / `−3`, while an attachment plugin may choose MIME-aware icons without any feature branch in the app.

Not implemented yet, do not write manifests against them: `theme.tokens`, `session.header.leading`, `session.status`, `session.footer`, `command.palette`, `notifications.channels`.

Unknown slots are skipped rather than fatal, so a newer manifest never crashes an older app. `muxr plugin check` warns when it skips one.

A settings row cannot name an app route. It opens a declarative screen from the same plugin:

```json
{ "slot": "settings.items", "id": "settings", "type": "settings-item",
  "label": "Example", "icon": "settings-outline",
  "action": { "type": "screen", "contributionId": "settings-screen" } }
```

`settings-screen` must be a declared `navigation.content` contribution with `type: "screen"`.

## Events

A plugin cannot poll. It renders when asked and answers when called, so
"when X happens, do Y" needs a declared trigger:

```json
{ "slot": "events", "id": "react-when-agent-stops",
  "on": "agent.status", "from": "working", "to": ["idle", "done", "blocked"],
  "action": { "type": "plugin.call", "contributionId": "on-stop", "include": "pane" } }
```

The transition is the signal, not the value: `agentStatus` sits at `done`
indefinitely, so only `from` -> `to` fires. The action is always your own read-mode `host.rpc` contribution. Event and shortcut callers do not provide write idempotency or cross-device deduplication, so manifests that reference a write-mode RPC are rejected. The kernel knows how to run a plugin and nothing else, so no feature name is spelled in the protocol. Your RPC receives `{ sessionId, status, from }`, plus a bounded `pane` tail when you ask for `"include": "pane"`.

Reacting on the phone rather than the host (speaking, vibrating, drawing) uses
a capability instead:

```json
{ "action": { "type": "capability", "name": "speech.wake", "include": "pane" } }
```

A capability name exists only because code compiled into the app claims it, the
same rule as a primitive, so a downloaded manifest references behaviour but never
ships it. An unregistered name is skipped, not fatal, so a newer manifest never
breaks an older app. The `speech.wake` capability is the worked example: the
manifest decides *when* the trigger fires, and the app's compiled handler decides
*what happens next*; the plugin supplies the timing, never the behaviour.

## Components

External extensions compose a closed native vocabulary. A `navigation.content` screen contribution composes these nodes:

- `section` and bounded `list` containers;
- `text`, `row`, `metric`, `badge`, `progress`, `chart`, `limits`, `divider`, and `empty` display nodes;
- bounded `code` and unified `diff` nodes rendered by the app with syntax highlighting, line numbers, selection, light/dark themes, and no plugin HTML;
- an expandable/collapsible `tree` bound to flat or nested runtime nodes, with optional lazy read source, leaf action, and folder `selectionField`;
- an RPC action `button` (with optional `fields`);
- bounded `text`, `switch`, and `select` `field` nodes for forms.

Screens declare an optional read-mode data RPC; node strings may bind its result with dotted paths only (`{{data.status}}`), never expressions. Form fields submit their current values as the RPC input object named by the button's `fields`. Screen buttons and form submission go through declared `host.rpc` contributions via `plugin.call` — a screen never invokes a pane-scoped Herdr action.

A tree accepts bounded nodes shaped as `{ name, path, kind: "folder" | "file", parent?, hasChildren? }`. Flat `parent` links avoid deep RPC objects. An optional read source is called with screen params plus `{ path }` when an unloaded folder opens:

```json
{
  "type": "tree",
  "title": "Explorer",
  "path": "data.tree",
  "source": { "type": "plugin.call", "contributionId": "list" },
  "selectionField": "cwd",
  "action": { "type": "screen", "contributionId": "file", "params": { "path": "{{item.path}}" } }
}
```

Folders toggle natively and may update `selectionField`; leaf actions remain in the closed action vocabulary. `source` must name a read-mode RPC. Runtime rendering is capped at 512 nodes, while lazy loading keeps large trees browseable without oversized RPC output.

A source preview binds the body and may bind a file name for automatic language detection. A fixed `language` may be supplied instead. Supported identifiers and common aliases are HTML/XML/SVG, CSS, JavaScript/JS, TypeScript/TS, JSX, TSX, JSON/JSONC, Markdown/MD/MDX, YAML/YML, TOML, INI, Bash/Shell/SH/Zsh, Dockerfile/Docker, GraphQL/GQL, Python/Py, Go, Rust/Rs, Java, C/C++/headers, SQL, PHP, Ruby/Rb, Swift, Kotlin/Kt/Kts, and HCL/Terraform. Unknown extensions/languages render as plain text; source remains bounded and selectable.

```json
{ "type": "code", "path": "data.body", "fileNamePath": "data.name" }
```

A diff binds a unified patch and uses the same app-owned highlighting vocabulary:

```json
{ "type": "diff", "path": "data.patch" }
```

A third-party review plugin can return both from one read RPC. The app owns the renderer; the plugin supplies bounded JSON. There is no plugin-supplied route, HTML, or renderer name. Host files still use `{ "type": "kernel.navigate", "target": "file", "path": "/repo/src/app.ts" }` and need a real session.

```json
{
  "schemaVersion": 1,
  "pluginId": "you.review",
  "minMuxrVersion": 11,
  "contributions": [
    {
      "slot": "host.rpc",
      "id": "read",
      "type": "rpc",
      "method": "read",
      "entry": "rpc.mjs",
      "mode": "read"
    },
    {
      "slot": "navigation.content",
      "id": "review",
      "type": "screen",
      "title": "{{data.name}}",
      "data": { "type": "plugin.call", "contributionId": "read" },
      "children": [
        { "type": "code", "path": "data.body", "fileNamePath": "data.name" },
        { "type": "diff", "path": "data.patch" }
      ]
    }
  ]
}
```

RPC output is bounded JSON such as:

```json
{ "name": "src/app.ts", "body": "export const value = 1;\n", "patch": "diff --git ..." }
```

Plugin `code`/`diff` nodes stay at the existing 64 KiB / 600-line transport ceiling. The native file route reads through `session.readFile` (512 KiB) and then renders at most 256 KiB / 2,000 lines with a visible truncation footer. Binary bytes never enter syntax or diff rendering.

`progress` renders a literal `value` (default max 100) or binds a numeric runtime path with optional `label` and `valueLabel`:

```json
{ "type": "progress", "path": "data.remaining", "max": 100, "label": "Plan remaining", "valueLabel": "{{data.remainingLabel}}", "tone": "positive" }
```

`chart` renders a bounded `bar`, `column`, `gauge`, or `ring` graphic from a runtime path. The data is an array of `{ "label": "Claude", "value": 42, "valueLabel": "42 tokens", "detail": "1h 53m", "tone": "positive" }` entries: at most 8, with sanitized 24-byte labels and details, finite non-negative values, and tones from the shared set. Bars render as labeled rows with the value in monospace and a fill that sweeps in on load; the optional `detail` follows the value as a second, quieter monospace figure, so a rate limit reads `Codex · ▓▓▓░ · 60% left · 2:30 PM · on pace`. A `column` chart reads a series left to right in source order and is the variant for time (days, hours), never for ranking. A `gauge` carries one value against its ceiling from the first entry, and shows its `detail` under the figure. A ring renders as a donut whose first entry supplies the center figure (`valueLabel` over `label`), so put the headline slice first; `tone: "secondary"` marks the track slice. The app owns all colors, pairs every fill with a visible label/value (information is never color-only), and exposes an accessibility summary that includes each `detail`; an empty or all-zero series renders `emptyText`. There are no axes, touch handlers, or plugin-supplied colors; fill animations are app-owned, decorative, and disabled under reduced motion.

```json
{ "type": "chart", "variant": "bar", "path": "data.agents", "title": "Token activity", "emptyText": "No activity today" }
```

`limits` renders one card that answers "can I start now, and when do I get more" from a bounded runtime payload: `{ "plan": "OpenCode Go", "verdict": "low", "windows": [ { "label": "Weekly", "window": "7d", "used": 90, "resetsIn": "4h 11m", "elapsed": 0.33, "pace": "low" } ] }`. The node's `title` and the payload's `plan` form the section's label row above the card, so the card opens with the verdict. The producer supplies `verdict` (`go`, `ahead`, `watch`, `low`, `limited`) and a percent-`used` share for each window; the app owns the wording, tones, and meters. Each window shows percent left, its reset, and optional `pace` (`limited`, `low`, `watch`, `ahead`, `on pace`, or `null` when the window has no usable length or reset, or has no usage yet). The built-in Usage host applies the same verdict rules to the headline and each calculable window; an unknown pace has no verdict text or warning colour. Meters use a 100% ceiling and an optional static tick at `elapsed`. At most 8 windows with sanitized 24-byte labels, an 8-byte `window` suffix, `used` finite 0..100 (otherwise the window is dropped), `elapsed` finite 0..1 (otherwise omitted), and no colors in the payload. With no windows, the card collapses to the section label plus `message` as one quiet line, or the node's `emptyText` when there is no message; with neither, the card renders nothing. Requires `minMuxrVersion: 14`.

```json
{ "type": "limits", "path": "data.limits", "title": "Right now" }
```

A `section` may set `"columns": 2` or `3` to lay summary nodes (`metric`, `badge`, `progress`, `text`, `row`, `empty`, `chart`, `divider`) side by side; the app collapses three columns to two on narrow screens. Sections containing `limits`, `field`, `button`, `tree`, `list`, `code`, or `diff` children must stay full width and are rejected with columns because those nodes need the full width — `limits` is a verdict, headline, and bars decision block, not a column tile; place it at section level. A bound `progress`, `chart`, or `columns` requires `minMuxrVersion: 13`. Row `icon`/`meta`, bound tones (`tonePath`), bound field values (`valuePath`), `limits`, and `limits.emptyText` require `minMuxrVersion: 14`.

muxr owns layout, typography, spacing, accessibility behavior, loading states, and light/dark rendering. Extensions provide content and intent.

### Localized manifest text

Every user-visible manifest string accepts either a plain string or a bounded localized value:

```json
{
  "default": "Inbox",
  "translations": { "es": "Bandeja", "pt-BR": "Caixa de entrada" }
}
```

The phone resolves the exact BCP-47 locale, then its base language, then `default`. A value may declare at most 16 unique locale tags; every translation is sanitized and uses the same field-specific length/UTF-8 budget as its default. IDs, paths, URLs, screen params, form values, and RPC input remain plain data strings. Localized values require `minMuxrVersion: 6`. RPC result text is runtime data and is not translated by the manifest contract.

Not supported:

- React/JavaScript/native module downloads;
- HTML, WebViews, Markdown renderers, SVG, arbitrary CSS, or remote images;
- arbitrary nesting, positioning, animation, gesture handlers, or render functions;
- password fields or contributions inside pairing, account, connection, security, permission, or update UI.

A plugin can use a compiled primitive already registered in the app. External packages cannot activate a widget that is not in the installed app binary. Boxed plugins are ordinary plugins; they do not own private components.

## Data

Static UI needs no backend. Dynamic UI declares a read-mode RPC contribution and binds its result by dotted path:

```json
{
  "contributions": [
    {
      "slot": "host.rpc",
      "id": "usage",
      "type": "rpc",
      "method": "usage",
      "entry": "rpc.mjs",
      "mode": "read"
    },
    {
      "slot": "navigation.content",
      "id": "usage-screen",
      "type": "screen",
      "title": "Usage",
      "data": { "type": "plugin.call", "contributionId": "usage" },
      "children": [
        { "type": "metric", "label": "Plan remaining", "value": "{{data.remaining}}" },
        { "type": "empty", "title": "Unavailable", "message": "Usage could not be loaded." }
      ]
    }
  ]
}
```

Bindings are dotted paths only. There is no expression language. Calculate derived values in your backend and return data that matches the declared schema.

The host limits input size (8 KiB of JSON), response size (64 KiB of stdout; output exceeding the limit is rejected rather than truncated), per-string transport size (64 KiB with controls/bidi/zero-width stripped and deep/wide structures dropped), ordinary text display size (4 KiB), duration, and concurrency. Calls have a 30-second host deadline and two-second hard-kill grace; the phone waits 40 seconds so it does not abandon work the host still runs. A four-process global cap is narrowed to two admitted calls per plugin and three per device. Deadline, revoke, and shutdown terminate the POSIX process group, release the slot without waiting for inherited pipes, and escalate to SIGKILL. stderr is bounded separately from stdout, so verbose logging cannot break a successful plugin. Unchanged manifests reuse a file-identity-keyed parsed projection while source, Herdr authority, and the final hash are recomputed on every catalog refresh. Offline apps label cached UI as stale and disable host actions.

The phone caches each validated manifest by plugin id plus immutable manifest hash and preserves unchanged snapshot identity. Invalidation frames retain their bounded plugin ids: only named data sources refetch, while an empty list after reconnect means a full refresh. A successful write reloads its screen data. Ambiguous write failures retain one idempotency key for the same hashed canonical input; success or changed input mints a new key, and secret plaintext is never retained in the retry store.

### Public RPC context

A read or write RPC may explicitly request public host snapshots:

```json
{ "slot": "host.rpc", "id": "list", "type": "rpc", "method": "list", "entry": "rpc.mjs", "mode": "read", "context": ["sessions"] }
```

Allowed values are `"sessions"` and `"workspace-tree"`. Immediately before spawning the entrypoint, the host builds a fresh sanitized snapshot and passes it separately as `MUXR_PLUGIN_CONTEXT_JSON`; bounded caller input is written to the child process's stdin. The schema is:

```json
{
  "schemaVersion": 1,
  "sessions": [{ "sessionId": "<id>", "label": "auth", "cwd": "/work/repo", "workspaceLabel": "repo", "tabLabel": "auth", "agentKind": "pi", "agentStatus": "working", "activeAt": "2026-08-15T12:00:00.000Z" }],
  "attention": [{ "sessionId": "<id>", "reason": "waiting", "detail": "answer needed", "at": "2026-08-15T12:01:00.000Z" }],
  "workspaces": [{ "label": "repo", "focused": true, "agentStatus": "working", "tabs": [{ "label": "auth", "focused": true, "agentStatus": "working", "sessions": [{ "sessionId": "<id>", "label": "task", "agentKind": "pi", "agentStatus": "working" }] }] }]
}
```

`sessions` includes `attention`; `workspace-tree` includes only label/status/focus and stable muxr session ids for tree relationships. The host caps context at 64 sessions, 64 attention rows, 16 workspaces, 24 tabs per workspace, 16 sessions per tab, and 48 KiB total; it sanitizes display text and never exposes secrets, terminal bytes, device ids, pane ids, workspace ids, tab ids, or other internal ids. Undeclared context is not supplied.

When a phone calls an RPC from a real session-scoped slot, the host enriches that call's **stdin input** with the current `paneId` and `cwd`. This is caller context for that one session action, not part of the broad `MUXR_PLUGIN_CONTEXT_JSON` snapshot. Machine/global screens cannot synthesize it from screen params, and the app never displays internal pane ids.

`item-list` read RPCs return bounded `items` and optional sheet-level `actions`; rows may carry an icon and up to three compact metadata values with the same bounded tones. Metadata is display guidance, not an accounting ledger: Changes sums staged and unstaged numstats, so a line edited in both views may be represented twice. `collection` read RPCs return bounded groups (`title`, `id`, `items`). Items have `id`, `title`, optional `subtitle`, `icon`, `glyph`, `status` (`primary`, `secondary`, `positive`, `warning`, `danger`), `pulsing`, ISO `timestamp`, and a validated `action`. `tree-sheet` read RPCs return `title` plus recursive `nodes` with `id`, `title`, optional `subtitle`, `icon`, `glyph`, `status`, `pulsing`, `current`, `action`, bounded long-press `actions`, and `children`. The phone validates and sanitizes every response and action before rendering.

## Actions

Rows, screen buttons, settings items, and RPC-backed `item-list` rows use one closed action vocabulary:

- `{ "type": "screen", "contributionId": "detail", "params": {} }` opens a screen in the same plugin;
- `{ "type": "plugin.call", "contributionId": "run", "input": {} }` calls a declared RPC;
- `{ "type": "capability", "name": "voice.start" }` invokes an installed phone capability;
- `{ "type": "kernel.navigate", "target": "session", "sessionId": "..." }` opens a session;
- `{ "type": "kernel.navigate", "target": "file", "path": "src/app.ts" }` opens a file in the current session;
- `{ "type": "kernel.navigate", "target": "web-view", "url": "https://..." }` opens the bounded in-app HTTPS viewer;
- `{ "type": "open-url", "url": "https://..." }` asks before opening the system browser;
- `{ "type": "attachment", "id": "...", "name": "...", "size": 42 }` downloads a current-session artifact. The name is frozen: approved plugin manifests carry it, so it is not renamed by the artifact unification.
- `{ "type": "secure-prompt", ..., "submit": { "type": "plugin.call", ... } }` submits one non-empty secret directly to a declared write RPC without persisting or displaying it;
- `{ "type": "confirm", ..., "destructive": true, "action": { "type": "plugin.call", ... } }` confirms a destructive declared write RPC.

Secure prompt and confirmation wrappers have one fixed nesting level and bounded title/message/placeholder/labels. Secure-input chrome adds the host-owned plugin display name and verified source above plugin-authored copy. Their nested RPC must exist and be write mode; both the shared parser and phone recheck this. The phone parses every RPC-returned action before dispatch. Unknown action types/targets, undeclared same-plugin screens or RPCs, unavailable capabilities, non-HTTPS/file URLs, oversized identifiers/paths/URLs/input, and file/attachment actions without session context are rejected. `item-list` has no attachment/change fallback: every returned item must contain a valid explicit action.

Every RPC declares `mode: "read" | "write"` (defaults to read). Write calls require a client idempotency key; the host replay-fences one key to one input, replaying a successful outcome for five minutes and dropping a rejected write so a genuine failure can re-execute on retry — the same key with different input is rejected instead. Data cards and screen data loaders may only reference read-mode RPCs. The client holds one key per pending write while its input is unchanged (cleared on success or input change), so an ambiguous failure can be retried without duplicating a successful write. Screen buttons never call pane-scoped Herdr actions.

An extension cannot silently submit terminal input, target whichever pane is focused on the desktop, read another extension's data, access keys, or call arbitrary files/methods.

## Notifications

Android foreground-service startup, keepalive ownership, notification permission, and the baseline authenticated notification are unconditional app-kernel infrastructure. They mount before optional plugin surfaces, so disabling any plugin cannot stop the service required before realtime microphone capture.

Plugins do not own OS permission or foreground-service lifetime. A future notification-policy contract may supply attributed wording/grouping on top of this baseline, but `notifications.lifecycle` and `lifecycle-notify` are not extension points.

## Trust

A Herdr backend runs unsandboxed as your computer user. Installing one is equivalent to trusting local code. muxr's declarative UI limits what reaches the phone; it does not sandbox the backend.

Approved `host.stream` children receive one short-lived broker token for that stream. The token is least-ambient routing: unapproved plugins, and plugins without a stream contribution, do not receive direct broker access, active calls are aborted when the stream exits, and peer credentials never enter the provider protocol or environment. It is not isolation from malicious code explicitly enabled as the same host user, which can read user files and inspect other same-user processes. Hostile-local-plugin isolation requires a separate OS sandbox architecture.

Enabling or linking a Herdr plugin is the user's trust decision. Every enabled plugin is available to connected phones by default; a phone can explicitly disable it, and disable/revoke remains authoritative. Manifest or authority changes refresh the immutable snapshot and hash but do not trigger per-device reapproval.

The Plugins screen shows the trusted Herdr name, source, requested contribution surfaces, warnings, and whether the package has executable backend hooks. Declarative screens render host-owned attribution above plugin content; the manifest cannot override it. The manifest hash still binds the complete parsed manifest, source identity, and Herdr authority so calls target one stable snapshot even though hash changes do not change the default-on policy.

Navigation content is scoped by plugin id and contribution id. `/plugin` renders that pair only. On the phone, enabled `navigation.primary` destinations render where the product puts them (home destination chips, sidebar tools) and route into `/plugin` with those ids; the declaration never positions product navigation. A `home.cards` data card may likewise set `contentContributionId` to open a declared `navigation.content` screen when tapped. A navigation item may declare `"badge": { "type": "plugin.call", "contributionId": "count" }`; the referenced read RPC returns `{ "count": 0 }`, the phone bounds it to 0–999, and the plugin—not the kernel—owns the badge policy.
## Compatibility and limits

- `schemaVersion` is a major version. Unknown majors do not render.
- Unknown slots/components/actions/nodes are skipped, not fatal.
- IDs are namespaced to the extension; duplicate contribution and screen-field ids are rejected.
- Screens are capped at 64 nodes and depth 4; select fields at 32 options; strings and each localized variant are bounded per field; localized values allow at most 16 BCP-47 tags.
- `plugin.call` input is capped at 8 KiB of JSON; RPC stdout and each transported result string are limited to 64 KiB (oversized stdout is rejected; strings are byte-capped and sanitized); ordinary displayed text is capped again at 4 KiB while bounded `code` nodes may use the larger result; deep/wide result structures are dropped rather than rendered raw; stderr is capped separately so verbose logging cannot break a successful plugin.
- Data cards reference read-mode RPCs only.
- Password and secret fields are not part of the screen vocabulary.
- External extensions cannot set global ordering priority.
- Disabled, removed, incompatible, or revoked extensions disappear after catalog reconciliation.

See the normative security and rollback rules in [`decisions/0005-pi-like-extension-runtime.md`](decisions/0005-pi-like-extension-runtime.md).

## Author loop

The required author experience is:

```bash
muxr plugin docs                # prints the installed guide and agent-skill paths
muxr plugin create hello-muxr   # writes a minimal three-file settings-screen plugin
muxr plugin dev ./hello-muxr    # validates and links it into Herdr
muxr plugin dev ./hello-muxr --web  # ...and opens the app in a browser with hot reload
muxr plugin check ./hello-muxr  # validates files, ids, slots, and primitives
```

`dev` deliberately reuses Herdr's link lifecycle rather than running a second watcher or plugin runtime. Re-run it after manifest edits, reconnect muxr, and inspect Herdr plugin logs while developing backend actions. Validation errors include the exact manifest path.

## README checklist

Every extension should explain:

1. what appears in muxr;
2. what runs on the host;
3. every permission/data selector/action it requests;
4. where it stores data or secrets;
5. offline behavior;
6. how to disable and unlink it;
7. supported muxr UI and Herdr versions.

`muxr plugin create` writes a minimal working plugin and is the fastest starting point; every plugin uses the same validator and public manifest contract as yours. The Files and Attachments add-ons are also full examples you can read or install: `muxr plugin install umeranjum17/herdr-files` `muxr plugin install umeranjum17/herdr-attachments`.

## Lists of real things

A `list` renders one row per entry of an array your RPC returns. Without this a
manifest could only address fixed indices.

```json
{ "type": "list", "title": "Repository", "emptyText": "No files", "rows": [],
  "repeat": { "path": "data.files", "template": {
    "type": "row", "title": "{{item.name}}", "subtitle": "{{item.path}}",
    "action": { "type": "screen", "contributionId": "file", "params": { "path": "{{item.path}}" } } } } }
```

`repeat.path` is a dotted path to an array; inside the template bind entry fields
with `{{item.x}}`. At most 32 entries render.

A `row` with an `action` becomes tappable and opens another `navigation.content`
screen in the same plugin. `params` values are bound the same way and are passed
as the input to that screen's data RPC, so a detail screen can load exactly the
record you tapped. The Files add-on (`umeranjum17/herdr-files`) is a complete worked example: list the
files in a repo, tap one, read it.

## Screen rows, tones and saved state

A screen `row` carries `title`, an optional prose `subtitle` (what the thing is,
one sans line), an optional `meta` line for facts in figures (ids, paths, times,
one mono line), an optional `value` figure, an optional static Ionicon `icon`
drawn in a 30pt tile, and an optional `tone`. A row whose `title` binds to empty
renders nothing, so bind a row to a field that is empty when there is nothing to
say and the row disappears — there is no `if`, this blank-hides rule (shared
with `text`, `badge` and `empty`) is the one conditional. Adjacent top-level rows
share one card with hairlines; a `row`, a `text`, a `row` is two cards and a
note, which is your order kept.

Say status with a tone, never with words alone: `text`, `badge`, `progress` and
`row` accept `tone` or a runtime-bound `tonePath` resolving to one of
`primary | secondary | positive | warning | danger`. A toned `text` renders as a
notice (dot plus sentence, anything after " · " quieter); `secondary` text is a
note. A toned row colours its `value`, or shows a dot when it has none. Return a
tone name from your backend and bind it — anything else resolves to no tone,
never an error, because a plugin may say *danger* but never *red*.

The validator refuses a manifest that sets both `tone` and `tonePath` on one
node (`... tone must be static or bound, not both`): a binding smuggled into
`tone` would throw on every older parser, while an unknown field is ignored, so
`tonePath` is the only form that degrades gracefully. The same exclusivity holds
for field `value`/`valuePath`, and `valuePath` is rejected on text fields because
a text field's `value` already binds.

A form opens showing what is saved: bind a switch or select with `valuePath`. A
switch reads `true` (or the string `'true'`) as on and anything else as off; a
select keeps the saved value when it names an option and falls back to the first
option otherwise. A field the user touched keeps its value across reloads.

Do not give the screen a `title` unless the title is data: the header already
shows your navigation label, and an in-body title resolving to the same string
is dropped. A blank `metric` value prints "—" instead of an empty line, because
a missing figure is information.

The same `terminal.key-row` contribution accepts up to eight `quickReplies`:
`{"label":"Run tests","text":"Run the relevant tests and report failures."}`.
Each phrase appears in the agent command palette (the composer's `/` button)
under Common replies and inserts text into the phone composer; the person can
edit it and must still press Send. The `keys` array
sends only validated terminal control sequences. The built-in key row is product
code; author your own replies and keys with a `terminal.key-row` contribution in
your own plugin (see `muxr plugin create`).

Realtime voice, Dictation, terminal keys, the workspace tree, and Panes are no longer bundled plugins — they are product code in the app, so there is nothing left to clone or override. This is a **breaking change** if you cloned `muxr.workspace-hierarchy`, `muxr.panes`, `muxr.control`, or `muxr.status` under the previously documented path: the clone keeps running after you upgrade, and because muxr never lets one plugin suppress another, you will see the surface twice — a duplicated workspace tree, a second Applications chip beside the product Panes screen, or the retired Usage screen beside the product Right-now card. Disable the clone after upgrading (`herdr plugin disable <your-clone-id>`); author your own version with the `dictate`/`tree-sheet` primitives in your own plugin instead.

`muxr.terminal-keys`, `muxr.panes`, `muxr.control`, `muxr.dictation`, `muxr.status`, and the retired realtime voice ids `muxr.voice`, `muxr.voice-gemini`, `muxr.voice-openai`, and `muxr.voice-codex` are retired ids: the host no longer serves those exact ids to any device, so a registration still carrying one does not double a surface — a stale dictation registration adds no second dictate button, and a stale voice registration adds no second voice screen or overlay — but none appears in Settings > Plugins, so you cannot see or disable them from the phone. Disable one on the machine instead (`herdr plugin disable <id>`); `muxr setup` retracts a stale in-bundle registration, and `muxr integrations uninstall` unlinks retired ids. Re-register your copy under an id of your own to keep it (a dictation or terminal-key copy adds its keys with a `terminal.key-row` contribution).

Direct edits under the global npm package work live but are replaced by the next npm install. A plugin you link yourself with `muxr plugin dev` survives package upgrades with its Herdr registration; subsequent `muxr setup` runs preserve its explicit enabled/disabled state.

muxr does not let one plugin suppress another, because a manifest that could hide a different plugin's UI would be a way to hide trusted surfaces. Disabling is an explicit per-device decision that stays with you.

A button on a detail screen sends its declared `fields` **plus the params the
screen was opened with**, so it can act on the record you tapped without making
you retype it. Fields win on a key collision.

## What a backend RPC gets

An installation can no longer grant a script private host configuration: the retired `plugins/private-contexts.json` registry is not read anymore, because its only consumer is now host product code and provider environment access is host-internal. No manifest or installation file grants a plugin process anything beyond the call input and the environment below.

The child receives the call input as bounded UTF-8 JSON on **stdin** (`"null"` when absent). Secrets from secure prompts are never placed in its environment. The child process is started with a deliberately small environment:

```
MUXR_PLUGIN_ID            your plugin id
MUXR_PLUGIN_STATE_DIR     a private directory for this plugin, owner-only
MUXR_PLUGIN_CONTEXT_JSON  bounded declared host context, when requested
PATH  HOME  MUXR_HOME  HERDR_BIN_PATH
```

Read input in Node with `JSON.parse(readFileSync(0, 'utf8') || 'null')`.

`MUXR_PLUGIN_STATE_DIR` is created for you under `$MUXR_HOME/plugin-state/<id>`
with mode 0700. Keep caches, saved commands and credentials there rather than
inventing a path under the user's home. It is not a secret vault: the host user
can read it, and so can any other plugin running as that user.

The working directory is the host's, so a plugin acts on the machine rather than
on its own folder.

## Testing a plugin without a phone

```bash
muxr plugin call ./my-plugin <contributionId> [--input '{"key":"value"}'] [--context '{"sessions":[]}']
```

Runs the RPC with the same stdin/environment contract and input/output limits,
using a private temporary state directory, then prints the parsed result. Pass a
bounded `--context` fixture for RPCs that declare host context. The author tool
does not reproduce host revocation or process-group lifecycle. `plugin check`
validates shape; `plugin call` proves wiring.

## Declaring what you need

```json
{ "schemaVersion": 1, "pluginId": "you.thing", "minMuxrVersion": 8, "contributions": [] }
```

`minMuxrVersion` is optional and is preserved when the host parses the manifest. UI version 15's product Right now card is retired: the Right-now card is host product code fed by the `usage.now` request, the `"product": "right-now"` data-card marker is ignored, and `muxr plugin check` no longer rejects anything over it. UI version 14 adds the declarative `limits` node (with an `emptyText` fallback for windowless payloads), row `icon`/`meta` identity fields, runtime-bound tones (`tonePath`) on `text`, `badge`, `progress` and `row`, runtime-bound field values (`valuePath`) on switch/select fields, and an optional agent-mark `glyph` id on tab strip entries, resolved against the app's bundled agent marks with a ringed-monogram fallback. `muxr plugin check` rejects a manifest that uses 14-only nodes without declaring it, and warns on screen node types it does not recognize (unknown nodes are skipped silently at runtime so old apps tolerate new manifests). UI version 12 allows generic `item-list` rows to omit actions for honest read-only status and metric lists; actionable rows still require a validated closed action. UI version 11 adds the bounded declarative `code` node and syntax highlighting for source previews and native unified diffs. UI version 10 adds the generic declarative `tree` node: per-folder expand/collapse, expand/collapse-all controls, optional lazy `host.rpc` children, closed leaf actions, and folder selection into an existing form field. UI version 9 adds provider-neutral `host.stream` contributions and strict encrypted stream transport. UI version 8 adds bounded per-row icons/metadata and optional sheet-level actions to the generic `item-list` response. UI version 7 adds plugin-owned `navigation-item.badge` read sources and singleton tree-sheet cardinality. UI version 6 adds bounded localized values for every user-visible manifest string and runtime Android launcher projection for shortcut contributions. UI version 5 removes `url-chip`; adds bounded active-only refresh and presentation parameters to `item-list`; and defines capability actions, Android launcher shortcuts, the realtime indicator, and singleton realtime-overlay cardinality. UI version 4 added source-driven grouped collections/tree sheets and allow-listed public RPC context. Each phone compares it with its own `MUXR_UI_VERSION`; an older app lists the plugin as unavailable with an update message and refuses to mount its contributions instead of quietly rendering partial UI.

## Capabilities

`capabilities` maps a semantic feature name to a `host.rpc` or `host.stream` contribution id. The app looks up features by name so core surfaces never hard-code a plugin id:

```json
"capabilities": {
  "example.session": "session"
}
```

```json
{ "slot": "host.stream", "id": "session", "type": "stream", "entry": "stream.mjs" }
```

### Agent close policy

Agent close is host code (`session.stop` calls the close ladder in
`apps/host/src/agent/infrastructure/agentClose.ts` directly on the live Herdr
socket), not a plugin RPC — there is no `close` entrypoint to claim and no
package identity to pin, and no `agent.close` capability name is consumed.
`session.stop` uses the
selected Agent Route only inside the host to resolve authority. The ladder
returns exactly one of:

- `{ "status": "closed" }`, optionally with `"alreadyGone": true`;
- `{ "status": "confirmationRequired", "scope": "tab" | "workspace" | "worktreeGroup", "label": string, "message": string }`;
- `{ "status": "retryable", "message": string }`.

The backend reads fresh Herdr topology before every mutation. Pane close needs no broader confirmation; tab, workspace, and worktree-group scopes each need their own explicit confirmation. If Herdr refuses an attempted scope after a race, the next confirmation must be strictly broader than both that attempt and the scope already confirmed. A failed revalidation returns Retry or an error, never `alreadyGone`; only a live snapshot that no longer contains the target may report it already closed. Cancel sends no request.

A stream process receives one private `realtime.open` line followed by bounded provider-neutral NDJSON frames. A PCM provider exchanges ready/audio/state/transcript/control frames and keeps its provider socket on the host. A WebRTC signaling provider exchanges bounded offer/answer SDP plus opaque data-channel control while the mobile kernel owns the peer and direct media. The host enforces approval revocation, admission, process cleanup, frame bounds, and encrypted relay transport.

Realtime voice is **not** a plugin: it is product code. The four adapters under `apps/host/src/voice/providers/` (xAI, Gemini Live, OpenAI Realtime, and experimental Codex Voice) are internal and swappable behind the typed `voice.*` host methods. Choose one under **Settings → Voice & dictation**. PCM providers keep their host-relayed stream; Codex adds only the generic WebRTC transport kind.

Realtime voice does not use this capability map: its `voice.*` surface is a typed product host request, so no plugin id, capability name, or manifest hash is involved. See [Voice setup](VOICE-SETUP.md).

Names are dotted ids; values must be contribution ids that exist in the same manifest. This semantic map resolves backend RPCs and streams. It is not a phone effect. Phone effects (`speech.wake`, `voice.start`) are
compiled into the app and referenced from events or shortcuts as
`{ "action": { "type": "capability", "name": "voice.start" } }`. An unregistered
phone-effect name is skipped, not fatal.

## Screen buttons

`session.header.trailing` accepts `type: "screen-button"` in addition to
`data-card`. A screen-button opens another contribution in the same plugin from
the header's three-dot pane menu.

```json
{
  "slot": "session.header.trailing",
  "id": "open",
  "type": "screen-button",
  "title": "Git history",
  "icon": "git-branch-outline",
  "contentContributionId": "history"
}
```

## Shortcuts

Contribute Android launcher entries with the `shortcuts` slot:

```json
{
  "slot": "shortcuts",
  "id": "jarvis",
  "label": "Jarvis",
  "longLabel": "Talk to the muxr voice agent",
  "synonyms": ["Jarvis", "voice agent", "talk", "live voice"],
  "action": { "type": "capability", "name": "voice.start" }
}
```

The app runs the same closed action union events use (`capability` or `plugin.call`). A cold shortcut first refreshes the enabled catalog and resolves the live contribution before any capability or RPC runs. If the host is unavailable or the plugin is disabled, the shortcut does nothing.

The app projects every currently enabled runtime contribution into Android's dynamic launcher shortcuts with `ShortcutManagerCompat`; disabling or uninstalling the plugin removes it on the next catalog refresh. Product shortcuts and any build-bundled plugin contributions are baked into `res/xml/shortcuts.xml` by `apps/mobile/plugins/withAppActions.js`, using the same public manifest contribution and localized resources. Both paths deep-link through `muxr://shortcut/<id>` and re-check the live enabled catalog before acting.

`synonyms` remain accepted as legacy aliases for deep links made by older builds. The Play build intentionally omits optional Assistant App Actions capability metadata because Google Play rejects those resources unless its separate Actions terms entitlement is active.

### Testing on a physical device

1. Install the release build on a phone.
2. Long-press the launcher icon and tap the contributed shortcut.
3. Or test the deep link directly:
   `adb shell am start -a android.intent.action.VIEW -d "muxr://shortcut/voice.jarvis"`
