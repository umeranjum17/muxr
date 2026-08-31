# Leveraging third-party Herdr plugins from muxr

**Date:** 2026-08-31
**Scope:** read-only investigation. Nothing under `/home/umer/herdr` was modified.
**Cases:** [`zenbu-labs/terminal-browser`](https://github.com/zenbu-labs/terminal-browser), [`smarzban/herdr-file-viewer`](https://github.com/smarzban/herdr-file-viewer)
**Companion:** [`plugin-architecture-review.md`](./plugin-architecture-review.md) (this report resolves its Gap 5)

---

## 0. Verdict up front

Three findings, in order of how much they change the plan.

**1. muxr can already stream a Herdr plugin pane to the phone. Today. No host change, no app change, no Herdr change.**

`herdrSessionSource.ts:738-741` enumerates *every pane without an agent* as a muxr session with the route `shell:<paneId>`. A `herdr-file-viewer` pane is a pane without an agent. It is therefore already a muxr session, already listed on the phone, and already attachable by `terminal.attach`. This was not designed for plugins; it falls out of the shell-pane support. It works anyway.

Verified live on this machine — `herdr pane list` right now returns three agent-less panes (`w1FC:p1`, `w1FC:p3`, `w1FC:p4`), each of which muxr exposes as `shell:w1FC:p3` and friends.

**2. `muxr-ui.json` is the wrong shape for the *content* of both plugins, and the right shape for *reaching* them.**

Neither plugin can be re-expressed as a declarative screen. One is a full-screen TUI, the other is a Chromium instance painting pixels. But the owner's restated goal — "even if we just open or focus on a terminal via a muxr-ui.json that is perfectly fine… right now it's not friendly to open" — is a *navigation* problem, and navigation **is** expressible in `muxr-ui.json` today. See §6.

**3. The brief's stated touch ceiling is wrong in muxr's favour, and the real ceiling is one line of missing JSON.**

Herdr's terminal-attach protocol already carries `source: page_key` (emitting real PageUp/PageDown) and already carries `column`, `row`, `modifiers` on scroll, and already routes wheel events into a mouse-reporting TUI as genuine SGR mouse sequences. muxr's client sends none of those extras. So a mouse-driven TUI **does** receive scroll today — at cell (0,0), forever, because muxr omits the coordinates.

And a click path is more reachable than expected: the cell hit-test already exists in the Ghostty Android view, the mouse-button enum is already bound on iOS, muxr already ships a patch to that package that added exactly this kind of callback, and Herdr already has a public mode-aware `encode_mouse_button`. See §5.

**The single highest-value change in this whole report is not a plugin. It is adding `column`/`row` to one `send()` call in `OpenTerminal.ts:358`.**

---

## 1. What the two plugins actually contribute

### 1.1 `zenbu-labs/terminal-browser`

Manifest at `herdr-plugin/herdr-plugin.toml` — the whole thing:

```toml
id = "zenbu-labs.terminal-browser"
name = "Terminal Browser"
version = "0.1.1"
min_herdr_version = "0.8.2"
description = "Open a browser inside herdr"
platforms = ["linux", "macos"]

[[build]]
command = ["bash", "-c", "set -o pipefail; curl -fsSL https://terminal-browser.sh/install | bash"]
platforms = ["linux", "macos"]

[[actions]]
id = "open-split"
title = "Open terminal-browser (right split)"
description = "Split the focused pane and open terminal-browser in it"
contexts = ["global"]
command = ["bash", "open-split.sh"]
```

| Herdr field | Used |
|---|---|
| `[[build]]` | 1 — `curl \| bash` installer |
| `[[actions]]` | 1 — `open-split`, context `global` |
| `[[panes]]` | **0** |
| `[[events]]` / `[[startup]]` / `[[link_handlers]]` | 0 |

`open-split.sh` is nine lines and ends in `exec terminal-browser open --split right`. The Herdr plugin is a **thin launcher**; the plugin does not declare a pane, it asks its own CLI to make one.

**How it renders — and why this is fatal for the phone.**

terminal-browser is a real Chromium instance using Electron offscreen rendering, painting pixels into the terminal via the **kitty graphics protocol** (`engine/crates/pixel-core/src/kitty.rs`). Inside Herdr specifically, it takes a dedicated path: `engine/crates/pixel-core/src/herdr.rs` reads `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` (`herdr.rs:20-26`) and drives Herdr's graphics API directly:

```rust
// herdr.rs:50
r#"{{"id":"info","method":"pane.graphics.info","params":{{"pane_id":{}}}}}"#
// herdr.rs:74
r#"{{"id":"stream","method":"pane.graphics.stream","params":{{"pane_id":{},"layer_id":"primary","z_index":0}}}}"#
```

Herdr keeps graphics on a **separate wire message** from terminal cells (`herdr/src/protocol/wire.rs:640-663`):

```rust
/// Terminal bytes to write directly for a terminal-ANSI client.
Terminal(TerminalFrame),
/// Client-local Kitty graphics bytes to write directly to the host terminal.
Graphics { bytes: Vec<u8> },
```

And `herdr terminal session control` — the exact subprocess muxr spawns — **explicitly discards them**:

```rust
// herdr/src/client/mod.rs:981
Ok(ServerMessage::Graphics { .. }) => {}
```

Only `ServerMessage::Terminal` is serialised to the `terminal.frame` NDJSON line muxr forwards (`client/mod.rs:955-968`).

> **terminal-browser on the phone shows an empty pane.** Its entire output is graphics frames, and muxr's transport drops 100% of them. This is not a tuning problem or a bandwidth problem. The pixels are not on the wire.

### 1.2 `smarzban/herdr-file-viewer`

| Herdr field | Used |
|---|---|
| `[[build]]` | 2 — unix `fetch-or-build.sh`, Windows `.ps1` |
| `[[panes]]` | **1** — `file-viewer`, `placement = "split"`, `command = ["./target/release/herdr-file-viewer"]` |
| `[[actions]]` | 4 — `open-file-viewer`, `open-file-viewer-tab`, + `-windows` variants |
| `[[events]]` / `[[startup]]` / `[[link_handlers]]` | 0 |

Its own manifest comment states the design intent plainly: *"The viewer appears ONLY in response to an explicit action (its keybinding) — there are no event hooks and no automatic invocation (AC-N4)."*

**How it renders.** A ratatui TUI in the alternate screen with mouse capture:

- `src/app.rs:826` — `execute!(io::stdout(), EnterAlternateScreen)?`
- `src/app.rs:204` and `:827` — `execute!(io::stdout(), EnableMouseCapture)`
- `src/controller/mouse.rs` — full pointer handling: wheel, divider drag, scrollbar click-to-scroll, click vs double-click

Crucially, from `docs/keys.md:7`:

> *"The viewer is **keyboard-first**: every function has a key and nothing requires a mouse."*

That sentence is the reason this plugin is viable on a phone and terminal-browser is not.

### 1.3 Contribution summary

| | terminal-browser | herdr-file-viewer |
|---|---|---|
| Emits structured data? | No | No |
| Owns a pane? | Yes (via its own CLI) | Yes (declared `[[panes]]`) |
| Output encoding | Kitty **graphics** frames | **ANSI** cells |
| Reaches muxr's transport | **No** — dropped at `client/mod.rs:981` | **Yes** |
| Usable without a mouse | No | **Yes**, by design |
| Value to the phone today | ~zero | high |

---

## 2. Is "add a muxr-ui.json" the cheapest path?

Answer per plugin, and it differs.

### 2.1 For rendering their content: no. A `muxr-ui.json` cannot express either one.

The declarative vocabulary (`docs/PLUGINS.md` §Components) is `section`, `list`, `text`, `row`, `metric`, `badge`, `progress`, `chart`, `divider`, `empty`, `code`, `diff`, `tree`, `button`, `field` — capped at 64 nodes and depth 4 (`MAX_SCREEN_NODES`, `MAX_SCREEN_DEPTH` in `packages/contract/src/plugins/domain/plugins.ts:625-626`). It is a *forms-and-lists* language. It has no canvas, no cell grid, no pixel surface, and no key-event input.

Both plugins are interactive full-screen surfaces whose entire value is the live rendering. Restating them declaratively would not be porting them; it would be **rewriting them as different products**.

For herdr-file-viewer specifically, a naive reading suggests "just use the `tree` node plus a `code`/`diff` node — that's a file viewer." It is not the same thing, and the gap is not cosmetic:

- the muxr `tree` renders at most 512 runtime nodes and screens cap at 64 declared nodes;
- `code`/`diff` bodies ride a 64 KiB RPC result and a plugin cannot syntax-highlight or drive `glow`/`delta`/`bat`;
- pin-and-compare, worktree switch, annotations, line-select, fuzzy find, changed-file jump, and baseline flip have **no representation at all** in the vocabulary.

And that rewrite already exists: `plugins/code` is muxr's bundled declarative file browser (8 RPCs, 6 screens, ~390 lines). Re-expressing herdr-file-viewer as JSON produces `plugins/code` again, minus the features people install herdr-file-viewer for.

> **Honest statement: a `muxr-ui.json` cannot express what either of these plugins does.** For terminal-browser, additionally, *nothing* can — its bytes never leave the host.

### 2.2 For reaching them: yes, and this is the actual answer.

Streaming the pane is the right shape for herdr-file-viewer, and the streaming already works (§3). What is missing is discovery and launch, and both are `muxr-ui.json` surfaces. §6 has the concrete manifest.

---

## 3. Streaming a plugin pane — full `terminal.attach` trace

**Question: does the terminal transport assume an agent session?**
**Answer: no. It is pane-generic from end to end, and the one session-shaped step already accepts non-agent panes.**

### 3.1 The trace

**Phone.** `TerminalView.tsx:150` calls `openTerminal({ agentRoute: sessionId, size })`. `OpenTerminal.ts:75-82` sends:

```ts
sync.request('terminal.attach', { sessionId, channel, cols, rows, ... })
```

**Contract.** `packages/contract/src/control-plane/domain/requests.ts:486-501` — params `{ sessionId, channel, cols, rows, mode?, deviceId?, takeover? }`, result `{ paneId }`.

**Host dispatch.** `createRequestDispatcher.ts:245` → `openTerminal(options.terminals, params)` → `TerminalPort.attach` (`openTerminal.ts:20`).

**Session → pane.** `terminalManager.ts:59`:

```ts
const paneId = await this.options.resolvePane(params.sessionId);
```

wired in `main.ts:615-621` to `source.open({ sessionId })` → `herdrSessionSource.ts:1476` `resolvePane` → `currentSession(sessionId)`.

**The load-bearing line.** `herdrSessionSource.ts:746-756`:

```ts
function currentSession(sessionId: string): CurrentSession | undefined {
    if (sessionId.startsWith(SHELL_ROUTE_PREFIX)) {          // 'shell:'  (:474)
        const paneId = sessionId.slice(SHELL_ROUTE_PREFIX.length);
        const pane = panesById.get(paneId);
        return pane === undefined || agentsByPane.has(paneId)
            ? undefined
            : { sessionId, paneId, pane };                    // <- no agent required
    }
    ...
```

and `currentSessions()` at `:738-741`, which *manufactures* a session for every agent-less pane:

```ts
for (const pane of panesById.values()) {
    if (!agentsByPane.has(pane.pane_id)) {
        sessions.push({ sessionId: shellRoute(pane.pane_id), paneId: pane.pane_id, pane });
    }
}
```

`panesById` is filled from Herdr's `session.snapshot` with no filtering (`:1185-1198`).

**Pane → bytes.** `terminalManager.ts:118-133` spawns:

```
herdr terminal session control <paneId> --takeover --cols N --rows M
```

A **pane id**, not a session id, not an agent. Herdr's own CLI is entirely pane-scoped.

### 3.2 What this means

| Claim | Verdict |
|---|---|
| `terminal.attach` assumes an agent session | **False.** `shell:` routes bypass the agent lookup entirely (`:747-753`). |
| A plugin pane can be attached by the existing transport | **True**, provided the pane has no agent — which a TUI/browser pane does not. |
| Host changes needed | **None.** |
| App changes needed | **None.** The phone already renders shell sessions (`sessionMapping.ts:100`, `homeDockEnvironment.ts:20` `'Shell (no agent)'`, `workspace/[id].tsx:121`, `TerminalScreen.tsx:453`). |
| Herdr changes needed | **None.** |

**Corollary — the review's Gap 5 is half-wrong and should be amended.** It said Herdr panes have "no muxr slot" and therefore contribute nothing to the phone. There is no *slot*, but there is a *route*: any plugin pane is reachable at `shell:<paneId>`. `muxr.control`'s six panes are on the phone right now if you can find them. Finding them is the actual problem, and that is §6.

### 3.3 `plugin.pane.open` — still unused, and still not needed

`plugin.pane.open` exists in Herdr with full placement/cwd/env (`herdr/src/api/schema/plugins.rs:418-440`). muxr never calls it — grep of `apps/host/src` finds `panes` only as an opaque field in the authority digest (`pluginCatalog.ts:138`, `:326`, `:359`).

It stays unnecessary for this work: the plugins ship their own `[[actions]]` that open their panes, and those actions are reachable (§6). Calling `plugin.pane.open` would be a *second* way to do what the plugin already does.

---

## 4. Touch today: what works, what breaks, and the real ceiling

### 4.1 The client's entire input vocabulary

`OpenTerminal.ts:352-360` — this is everything the phone can say:

```ts
sendText: (text)      => send({ type: 'terminal.input', text }),
sendBytes: (base64)   => send({ type: 'terminal.input', bytes: base64 }),
resize: (cols, rows)  => send({ type: 'terminal.resize', cols, rows }),
scroll: (lines)       => send({ type: 'terminal.scroll', direction: lines > 0 ? 'up' : 'down', lines: n }),
```

### 4.2 What Herdr *accepts* — strictly more than muxr sends

`herdr/src/client/mod.rs:989-1020`:

```rust
#[serde(rename = "terminal.scroll")]
Scroll {
    direction: TerminalControlScrollDirection,
    lines: u16,
    #[serde(default)] source: TerminalControlScrollSource,   // wheel | page_key
    #[serde(default)] column: Option<u16>,
    #[serde(default)] row: Option<u16>,
    #[serde(default)] modifiers: u8,
},
```

**muxr sends `direction` and `lines` and nothing else.** `source` defaults to `Wheel` (`:1029-1033`) and `column`/`row` arrive as `None`.

### 4.3 What Herdr does with a wheel event — the surprise

`herdr/src/server/headless.rs:340-400`, routing by the pane's live terminal mode (`src/app/input/mouse.rs:1856-1864`):

```rust
match runtime.wheel_routing() {
    Some(WheelRouting::MouseReport) => {                    // TUI has mouse reporting on
        let column = column.unwrap_or(0);
        let row = row.unwrap_or(0);
        let Some(bytes) = runtime.encode_mouse_wheel(wheel_kind, column, row, modifiers) else { ... };
        runtime.try_send_bytes(...)                          // real SGR mouse event
    }
    Some(WheelRouting::AlternateScroll) => { ...encode_alternate_scroll... }
    Some(WheelRouting::HostScroll) | None => { runtime.scroll_up/down(lines) }
}
```

> **The brief's premise that "TUIs in the alternate screen ignore forwarded mouse sequences" does not apply here.** Herdr does not blindly forward anything. It inspects `mouse_protocol_mode.reporting_enabled()` and synthesises a correct, mode-appropriate event. A phone drag on herdr-file-viewer **does** reach its `handle_mouse` as a wheel event today.

Likewise `source: "page_key"` (`client/mod.rs:1081-1088`) emits real `\x1b[5~` / `\x1b[6~`, falling back to host scrollback only when the pane wants that (`plain_page_keys_use_host_scrollback`). **PageUp/PageDown exist on this wire.** (The brief's claim is true of the `pane.send_keys` *RPC*; it is not true of the streaming transport, which is the path that matters.)

### 4.4 So what actually breaks

**Break 1 — every wheel event lands at cell (0, 0).**

muxr omits `column`/`row`, so `unwrap_or(0)` puts every scroll in the top-left cell. For herdr-file-viewer, which is a two-column layout with the **tree on the left and the content preview on the right**, column 0 is always the tree. Scrolling the preview with a finger is impossible — not because the event is lost, but because it is delivered to the wrong pane, every time.

*Cost to fix: pass the two numbers the wire already accepts.* `expo-libghostty`'s `onScroll` currently reports `{ rows }` only, so the touch x/y must be added to that callback (patch, §5) — or a fixed sensible column can be sent immediately with no native change at all.

**Break 2 — there is no click, anywhere.**

`node_modules/expo-libghostty/src/ExpoLibghostty.types.ts` — the complete prop surface:

```ts
onInput?:  (event: { nativeEvent: TerminalInputEvent }) => void;   // { data, text }
onResize?: (event: { nativeEvent: TerminalResizeEvent }) => void;  // { cols, rows }
onScroll?: (event: { nativeEvent: { rows: number } }) => void;     // rows only
```

No pointer event, no coordinates, no button. And Herdr's attach protocol has no `terminal.mouse` frame — `TerminalControlCommand` (`client/mod.rs:989-1020`) is `input | resize | scroll | release`.

> **Tap-to-position does not exist today, at any layer.** Not in the app, not in the wire. This is the honest ceiling.

**Break 3 — no PageUp/PageDown is currently sent**, despite the wire supporting it. Fixable in pure JSON (§6.1).

### 4.5 Consequence per plugin

| Interaction | herdr-file-viewer | terminal-browser |
|---|---|---|
| Typing keys / IME | works | n/a |
| Escape sequences via key row | works | n/a |
| Wheel scroll | reaches the TUI, **always at column 0** (tree only) | n/a |
| PageUp/PageDown | wire supports, muxr doesn't send | n/a |
| Click / tap-to-position | **absent at every layer** | absent |
| Seeing anything at all | fine | **impossible** — graphics dropped |

For herdr-file-viewer this is a *good* outcome, because it is keyboard-first by design (`docs/keys.md:7`). Every function has a key: `f` find, `p` pin, `v` cycle view, `]`/`[` changed-file jump, `b` baseline, `W` worktree, `L` copy ref, `Z` zoom, `?` help, `Tab` focus, `hjkl` scroll, `Space`/`PageDown` page. **The mouse is additive, not required.** A key row makes the whole plugin usable from a phone.

---

## 5. Can we patch Ghostty for touch / synthetic mouse clicks?

**Yes — and it is more tractable than it looks, because every prerequisite is already in place.** This is the honest engineering assessment, with the caveat that it is the most invasive option here.

### 5.1 muxr already patches this package, for exactly this class of change

`patches/expo-libghostty+0.8.1.patch` (12 KB, patch-package) already modifies **7 files across both platforms**, and one of its three tracked invariants is the *host-owned scroll callback* — the same shape a click callback needs.

Android, from the patch:

```kotlin
// ExpoLibghosttyView.kt
+    view.onScrollRows = { rows ->
+      onScroll(mapOf("rows" to rows))
+    }

// GhosttyTerminalView.kt
-        GhosttyVt.nativeScroll(handle, deltaRows)
+        onScrollRows?.let { it(deltaRows) } ?: GhosttyVt.nativeScroll(handle, deltaRows)
```

iOS gets the matching `hostScrollHandler` in `ExpoLibghosttyView.swift` and `UITerminalView.swift`, plus `Events("onInput", "onResize", "onScroll")` in the module. `apps/mobile/sources/terminal/application/ghosttyPatch.spec.ts` guards all of it against silent regression.

**Precedent established: adding a native→JS event to this view is a known, tested, maintained operation in this repo.**

### 5.2 The cell hit-test already exists in the Android view

`node_modules/expo-libghostty/android/.../GhosttyTerminalView.kt`:

```kotlin
:180  private val gestureDetector = GestureDetector(
:185      override fun onSingleTapUp(e: MotionEvent): Boolean { ... }
:205      override fun onLongPress(e: MotionEvent) {
:207        lastPressCol = (e.x / cellWidth).toInt().coerceIn(0, cols - 1)
:208        lastPressRow = (e.y / cellHeight).toInt().coerceIn(0, rows - 1)
```

Pixel→cell conversion is already written, already correct, already used for long-press. A tap→`(col, row)` callback is a handful of lines next to the existing `onScrollRows`.

### 5.3 iOS already binds libghostty's mouse-button type

`ios/vendor/GhosttyTerminal/Platform/UIKit/UITerminalView+Interaction.swift:227`:

```swift
func pointerButton(from event: UIEvent?) -> ghostty_input_mouse_button_e
```

Pointer phase handling, pan/long-press recognisers, and point→selection math are all present (`:130-330`).

### 5.4 Herdr already has the mode-aware encoder

This is the piece that makes a synthetic click *safe* rather than a hack. `herdr/src/terminal/runtime.rs:465-483`, public, sitting immediately beside the `encode_mouse_wheel` the attach path already uses:

```rust
pub fn encode_mouse_button(&self, kind: MouseEventKind, column: u16, row: u16,
                           modifiers: KeyModifiers) -> Option<Vec<u8>>;
pub fn encode_mouse_motion(&self, kind: MouseEventKind, column: u16, row: u16,
                           modifiers: KeyModifiers) -> Option<Vec<u8>>;
```

It returns `Option` — `None` when the pane has no mouse reporting on. **That is the safety property.** It is why this must go through Herdr rather than being faked on the phone.

### 5.5 Two ways to do it, and only one is acceptable

**❌ Cheap and wrong: encode SGR on the phone and send it as `terminal.input` bytes.**
`sendBytes` already accepts arbitrary bytes, so `\x1b[<0;{col};{row}M` would "work" — but the phone has no idea whether the pane has mouse reporting on, or whether it wants SGR (1006) vs X10 vs urxvt encoding. Get it wrong and you type `[<0;12;5M` into someone's shell. On a plain bash pane that is a mistyped command; on an agent pane it is corrupted input. **Do not do this.**

**✅ Correct: a `terminal.mouse` frame in Herdr's attach protocol.**

1. **Herdr** (~40 lines, additive, mirrors code that already exists): add a `terminal.mouse` variant to `TerminalControlCommand` (`client/mod.rs:989`), a `ClientMessage::AttachMouse` (`protocol/wire.rs:400`), and an `apply_terminal_attach_mouse` beside `apply_terminal_attach_scroll` (`headless.rs:340`) that calls `encode_mouse_button`/`encode_mouse_motion` and **silently no-ops on `None`**. Same file, same shape, same safety model as the wheel path.
2. **Ghostty patch** (~60 lines across Kotlin + Swift + types): emit `onCellTap { col, row, button, phase }`; add `col`/`row` to the existing scroll callback.
3. **muxr** (~20 lines): forward it in `TerminalView.tsx`; add `mouse()` to `TerminalChannel` in `OpenTerminal.ts`; extend the contract type.

Herdr is upstream and not muxr's to change unilaterally — but this is a small additive change that reuses existing public API, which makes it a reasonable upstream ask rather than a fork.

**Reality check.** A tap becomes a click. Drag-select, hover, double-click timing, and momentum are separate problems. This buys "tap the preview pane to focus it, tap a tree row to select it" — which for herdr-file-viewer is most of what a mouse is for, since everything else has a key.

---

## 6. The owner's actual question: "not friendly to open"

> *"Even if we just open or focus on a terminal via a muxr-ui.json that is perfectly fine as well but the idea is to leverage it control it from here — we have all the terminals already but right now it's not friendly to open."*

Correct diagnosis. The panes are all reachable at `shell:<paneId>` (§3); there is just no good way to *find* or *summon* them from the phone. Both halves are `muxr-ui.json` surfaces.

### 6.1 Focusing an existing pane — works today, unmodified

`kernel.navigate` with `target: "session"` takes an **arbitrary session id string**:

- contract: `packages/contract/src/plugins/domain/plugins.ts:369`
- `RunPluginAction.ts:86` → `{ kind: 'focus-agent', agentRoute: action.sessionId }`
- `pluginActions.ts:29` → `navigateToSession(router, agentRoute)`
- `FocusAgent.ts:14` → `` `/session/${encodeURIComponent(agentRoute)}` ``

There is **no allow-list and no cross-check** against known sessions. Pass `shell:w1FC:p3` and the phone opens that pane's live terminal.

Item-list rows and sheet actions run the same `parsePluginAction` (`RunPluginAction.ts:51`, `itemListModel.ts:106`/`:136`), so this composes.

**A "Panes" plugin, ~50 lines total:**

```json
{
  "schemaVersion": 1,
  "pluginId": "you.panes",
  "minMuxrVersion": 8,
  "contributions": [
    { "slot": "host.rpc", "id": "list", "type": "rpc", "method": "list",
      "entry": "rpc.mjs", "mode": "read" },
    { "slot": "navigation.primary", "id": "nav", "type": "navigation-item",
      "label": "Panes", "icon": "grid-outline", "contentContributionId": "screen" },
    { "slot": "navigation.content", "id": "screen", "type": "native",
      "primitive": "item-list",
      "params": { "title": "Panes", "icon": "terminal-outline",
        "source": { "type": "plugin.call", "contributionId": "list" } } }
  ]
}
```

`rpc.mjs` runs `herdr pane list`, filters to panes with no `agent` key, and returns one row per pane:

```js
{ id: p.pane_id, title: p.terminal_title_stripped ?? p.label, subtitle: p.cwd,
  icon: 'terminal-outline',
  action: { type: 'kernel.navigate', target: 'session', sessionId: `shell:${p.pane_id}` } }
```

**Zero app changes, zero host changes, zero Herdr changes.** Live-verified shape: `herdr pane list` returns exactly these fields today.

**Caveat, stated plainly:** `host.rpc` children get only `PATH HOME MUXR_HOME MUXR_PLUGIN_ID MUXR_PLUGIN_STATE_DIR` (`pluginCatalog.ts:485-496`) — **no `HERDR_BIN_PATH`, no `HERDR_SOCKET_PATH`**. And `MUXR_PLUGIN_CONTEXT_JSON` deliberately never contains pane ids (`docs/PLUGINS.md` §"Public RPC context"). So the RPC must shell out to a bare `herdr` on `PATH`. That is exactly what the bundled `plugins/code/files.mjs:10` already does:

```js
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
```

It works. It is also Gap 2 of the architecture review — an unsanctioned back door that every plugin needing Herdr is forced through. Building on it is pragmatic; it should be recorded as debt, not blessed.

### 6.2 A key row for the viewer — pure JSON, no rebuild

`terminal.key-row` sends arbitrary escape bytes (`plugins.ts:288-303`; dispatched via `channel.sendText` at `DeclarativePluginSlot.tsx:70`). herdr-file-viewer's whole key table becomes a manifest:

```json
{ "slot": "terminal.key-row", "id": "fv", "type": "key-row", "keys": [
  { "label": "PgUp", "accessibilityLabel": "Page up",   "send": "\u001b[5~" },
  { "label": "PgDn", "accessibilityLabel": "Page down", "send": "\u001b[6~" },
  { "label": "f",  "accessibilityLabel": "Find file",     "send": "f" },
  { "label": "v",  "accessibilityLabel": "Cycle view",    "send": "v" },
  { "label": "]",  "accessibilityLabel": "Next changed",  "send": "]" },
  { "label": "p",  "accessibilityLabel": "Pin file",      "send": "p" },
  { "label": "Z",  "accessibilityLabel": "Full screen",   "send": "Z" },
  { "label": "?",  "accessibilityLabel": "Help",          "send": "?" }
] }
```

This also closes Break 3 — PageUp/PageDown from the phone, with no native or wire change.

> **Limitation, stated plainly: key rows are global and unconditional.** `DeclarativePluginSlot.tsx:201-202` renders *every* enabled `terminal.key-row` contribution with no session filtering, and `docs/PLUGINS.md` is explicit that one plugin may not suppress another. A file-viewer key row appears on **every** terminal, including agent panes, where `v`/`p`/`f` are just letters. There is no per-pane or per-plugin scoping in the contract. Users can disable the row per device; that is the only control.

### 6.3 Opening a pane from the phone — the honest gap

Two mechanisms exist, neither is clean.

**`plugin.invoke` — real, but same-package only.**
`session.toolbar` + `{"type":"plugin.invoke","actionId":"…"}` reaches `plugin.action.invoke` with muxr-resolved context (`herdrSessionSource.ts:2084-2106`). But the action id is resolved as `catalog.action(pluginId, manifestHash, contributionId)` (`:2161`) and then re-verified against `plugin.list {plugin_id: pluginId}` (`:2088-2090`). **A separate `muxr-ui.json` cannot name `herdr-file-viewer`'s action.** It would have to live *inside* the third-party plugin folder — meaning an upstream PR or a fork.

Also: `plugin.invoke` is **not** in the `PluginAction` union (`plugins.ts:363-392`). It exists only as `PluginToolbarButton.action` (`plugins.ts:58-64`) on the `session.toolbar` slot. It cannot be an item-list row action, a screen button, or a settings item.

**A write RPC that shells out — works, same back door as §6.1.**
A `mode: "write"` RPC running `herdr plugin action invoke herdr-file-viewer.open-file-viewer` (or `pane split` + `pane run`) opens the pane. The RPC's return value is not dispatched as an action, so the flow is two taps: *tap "Open Files viewer"* → list refreshes → *tap the new pane*. Acceptable, and honest about what it is.

**Not available:** `plugin.pane.open` is never called by muxr (§3.3). The `herdr.cli` request (`requests.ts:247-250`, dispatcher `createRequestDispatcher.ts:143`) passes an arbitrary argv to `execFile` — but it is a **native muxr request reachable only from app code**, not from a plugin manifest. Do not design a plugin around it.

### 6.4 What "friendly" costs, concretely

| Piece | Where | Change |
|---|---|---|
| List agent-less panes, tap to open the live terminal | new plugin, JSON + ~40-line `.mjs` | none to app/host/Herdr |
| Viewer key row incl. PageUp/PageDown | same plugin, JSON only | none |
| Wheel events hit the right column | `OpenTerminal.ts:358` + patch for x/y | 1 line + native patch |
| One-tap "open the viewer" | write RPC shelling to `herdr` | none, but rides Gap 2 |
| Tap-to-position | Herdr frame + Ghostty patch + muxr | §5 |

---

## 7. Ranked options

### Option 0 — Do nothing · **0 days**

Not absurd. Plugin panes are *already* streamable at `shell:<paneId>` (§3); the phone already lists shell sessions. A user who opens herdr-file-viewer at the desk can already drive it from the phone with the keyboard and the existing arrow key row.

**Buys:** correctness — nothing is broken.
**Costs:** discovery is poor, scroll always hits column 0, no PageUp/PageDown, no one-tap open.
**Take it if:** nobody has actually asked to use these plugins from a phone yet. Verify demand before building.

### Option 1 — Send `column`/`row` on scroll · **~0.5 day** ⭐ *best value in this report*

`OpenTerminal.ts:358` omits two optional fields Herdr has always accepted. Even a fixed column derived from the touch x (or, with zero native change, a sensible constant like `Math.floor(cols/2)`) puts wheel events in the content pane instead of the tree.

**Buys:** scroll works correctly in *every* two-pane TUI on the phone — file viewers, `htop`, `lazygit`, `k9s`. Not plugin-specific.
**Costs:** to use the real touch x/y, needs the Ghostty patch to add x/y to `onScroll`. Without it, a heuristic column.
**Risk:** very low. Herdr already defaults these to `None`.

### Option 2 — A "Panes" plugin: list + focus + key row · **~1-2 days**

§6.1 + §6.2. One folder: `herdr-plugin.toml`, `muxr-ui.json`, `rpc.mjs`. A navigation destination listing every agent-less pane, each row navigating to its live terminal; plus a key row with PageUp/PageDown and the viewer's letter keys.

**Buys:** the owner's stated goal — *"we have all the terminals already but right now it's not friendly to open."* Generic: it surfaces `muxr.control`'s six panes and every plain shell too, not just these two plugins.
**Costs:** the RPC shells out to a bare `herdr` on `PATH` (Gap 2). The key row shows on every terminal (§6.2). Two taps to open-then-focus.
**Risk:** low, and it is a *deletable* folder if it does not land.

### Option 3 — One-tap open, upstreamed · **~2-3 days + PR latency**

Add a `muxr-ui.json` with a `session.toolbar` button **inside** herdr-file-viewer's own repo, using `plugin.invoke` against its existing `open-file-viewer` action. Zero muxr code. Requires an upstream PR (its `CONTRIBUTING.md` demands human-written PR descriptions and minimal diffs — this qualifies).

**Buys:** the genuine "one artifact, two tools" story from `docs/PLUGINS.md`, proven on a third-party plugin. Also becomes the first real user of `session.toolbar`, which the review found shipping dead.
**Costs:** not self-serve — depends on a maintainer. Confined to `session.toolbar` (a session must be open first).
**Risk:** medium — social, not technical.

### Option 4 — Ghostty patch + `terminal.mouse` in Herdr · **~1-1.5 weeks + upstream** 

§5. Tap-to-position and correct scroll coordinates.

**Buys:** real pointer input for every TUI on the phone.
**Costs:** touches a vendored native patch on two platforms *and* needs an additive Herdr change. Grows `patches/expo-libghostty+0.8.1.patch` and the invariants `ghosttyPatch.spec.ts` must guard.
**Risk:** medium-high. Every `expo-libghostty` upgrade re-applies it. Do **not** shortcut it by encoding SGR on the phone (§5.5).
**Take it if:** Options 1-2 ship and touch is still the top complaint. Not before.

### Option 5 — Graphics passthrough for terminal-browser · **months, probably never**

Would require: muxr's transport to carry `ServerMessage::Graphics` instead of dropping it (`client/mod.rs:981`), a kitty-graphics decoder in the mobile app, image compositing over the Ghostty cell grid, and a bandwidth story for full-motion Chromium over a phone link.

**Buys:** terminal-browser on the phone.
**Costs:** enormous, for a plugin whose value (a real browser) the phone **already has natively** — plus muxr already ships `kernel.navigate target: "web-view"` and `target: "preview"` for exactly this need.
**Recommendation: do not build this.** If someone wants a webpage from a session on their phone, `{"type":"kernel.navigate","target":"preview","port":3000}` is one line of JSON and works today.

### Recommendation

**Option 1 + Option 2** (~2 days total). Option 1 is a one-line correctness fix with leverage far beyond these plugins. Option 2 is one deletable folder that delivers the owner's stated goal and is generic across every pane on the machine.

Then stop and measure. Option 3 only if herdr-file-viewer proves it earns daily phone use; Option 4 only if touch is still the complaint after Options 1-2 ship; Option 5 never.

---

## 8. Answers, condensed

**Q1 — What do they contribute?**
terminal-browser: 1 `[[build]]`, 1 `[[actions]]` (`open-split`, global), no `[[panes]]`; a launcher for a Chromium-in-terminal that paints via kitty graphics. herdr-file-viewer: 2 `[[build]]`, 1 `[[panes]]` (`file-viewer`, split), 4 `[[actions]]`; a keyboard-first ratatui TUI in the alternate screen. **Neither emits data. Both own a pane.**

**Q2 — Is `muxr-ui.json` the cheapest path?**
For their *content*, no — a declarative screen cannot express either, and for terminal-browser nothing can. For *reaching* them, yes: `kernel.navigate target: "session"` with `shell:<paneId>` plus an `item-list` is the answer, and it works unmodified today.

**Q3 — Can a plugin pane use the existing transport?**
**Yes, with no change anywhere.** `terminal.attach` is pane-generic; `resolvePane` accepts `shell:<paneId>` (`herdrSessionSource.ts:747-753`); `currentSessions()` manufactures a session for every agent-less pane (`:738-741`); `herdr terminal session control` takes a pane id. It does **not** assume an agent.

**Q4 — Touch?**
Keys and IME work. Scroll works and Herdr correctly synthesises mouse-reporting events for alt-screen TUIs (`headless.rs:363-385`) — but muxr omits `column`/`row`, so every scroll lands at cell (0,0), i.e. the tree column. PageUp/PageDown are on the wire (`client/mod.rs:1081-1088`) but muxr never sends them; a JSON key row fixes that. **Click does not exist at any layer** — `expo-libghostty` exposes no pointer event, and Herdr's attach protocol has no mouse frame. That is the ceiling, and §5 prices removing it.

**Q5 — Ranked options?**
§7. Recommendation: Option 1 (scroll coordinates, ~0.5 day) + Option 2 (Panes plugin, ~1-2 days). Do nothing about terminal-browser.
