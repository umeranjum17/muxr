# Architecture

Three processes. Herdr owns agents and backend plugins, the host translates, the
relay moves bytes, and the app draws the terminal. The app is a native extension
shell: host-installed packages contribute approved native surfaces without downloaded code.

```
  PHONE / WEB               RELAY                   YOUR MACHINE
  apps/mobile               apps/relay              apps/host          herdr server
  ─────────────             ─────────               ──────────         ────────────
  xterm.js + herd UI   ◄──► routes envelopes   ◄──► translates    ◄──► owns the PTYs
  owns no truth             reads headers only      contract ⇄          detects agents
                            /terminal + /preview    herdr socket        resumes them
                            are separate channels
```

## Why herdr

Herdr is a multiplexer: it owns real PTYs, detects agent processes, tracks each
one's lifecycle, and
survives restarts. muxr drives *herdr* instead of any single CLI, so every
agent works the same way.

The consequence: there is no per-agent transcript to render. What the agent draws
is what you see. Approvals happen in the terminal, with the same keys you would
press at the desk.

## Where the terminal bytes live

First, the mental model: **there is no "the terminal".** An agent never draws a
screen — it writes ANSI escape bytes into a PTY (a kernel pipe). A terminal is
just any program that parses those bytes into pixels: Ghostty on the desk,
herdr's built-in emulator, xterm.js on the phone. Same bytes in, same picture
out — that is why every client looks identical.

**herdr owns the pipe and the canonical state.** Agents run as ordinary OS
processes on the host machine, each inside a real PTY that herdr holds. Herdr's
own emulator parses the bytes into the one true screen model (and keeps the
scrollback) in the server process. Because herdr sits on the pipe, it can feed
*any number of independent UIs at once* — its own desktop client, this app, or
anything else that asks. Each consumer runs its own emulator over a tap of the
same stream:

```
agent process → PTY (kernel pipe, herdr holds it)
                  │
                  ├─→ herdr's emulator ──→ herdr desktop UI
                  └─→ host runs `herdr terminal session control <pane>`
                      (base64 ANSI frames) → /terminal via the relay → phone
                      → xterm.js parses the same bytes, draws its own copy
```

Keystrokes travel the reverse path: phone → relay → host → herdr → PTY → the
agent reads them as if typed locally. This app owns no terminal state — it
carries bytes and renders them. And this is why scroll gestures are forwarded to
herdr instead of scrolling locally: the history is herdr's, and the phone only
holds the frames it was fed.

## Extension architecture

muxr follows Pi's lean-shell idea without downloading executable mobile code.
A package installed through Herdr may be backend-only, UI-only, or combined:

```text
extension package
├── herdr-plugin.toml   optional actions, panes, startup, and event hooks
├── muxr-ui.json        optional native mobile contributions
├── backend files       optional host execution
└── README.md           authority, data, compatibility, removal

Herdr executes the declared backend hooks.
muxr snapshots and renders the approved declarative UI.
```

The mandatory app kernel owns pairing, E2EE, transport, normalized reconnecting
state, terminal rendering, native OS bridges, and the plugin runtime. The phone
talks `plugin.list` / `plugin.manifest` / `plugin.call` / `plugin.invoke`. Protocol
v1 ships settings sections, session toolbar actions, approved host RPC, generic
native slots, declarative terminal keys/navigation/settings/data cards, shortcuts,
and a central primitive registry. The phone is a dumb translator of `muxr-ui.json`:
it mounts slots and draws widgets. Inbox, Voice, Changes, Attachments, terminal
keys, usage, and the workspace sheet are ordinary plugins that compose those
widgets and call host backends. Preview transport/viewing is kernel substrate;
plugins reach it only through the validated current-session preview action.
Navigation destinations open `/plugin`.

Bundled extensions compose the same primitives as any other plugin. The app
registers widgets (`item-list`, `collection`, `icon-button`, `realtime-session-overlay`, …), not plugin ids. External
extensions use those widgets too. Neither path permits downloaded React.

The normative protocol, trust chain, failure cases, rollback, and extraction
boundary are in [decision 0005](decisions/0005-pi-like-extension-runtime.md).
The approachable author guide is [Build a muxr plugin](PLUGINS.md).

## Ownership boundaries

**herdr owns**: processes, panes, workspaces, tabs, layouts, agent detection,
lifecycle state, scrollback, worktrees. If herdr doesn't know about it, it doesn't
exist.

**The host owns**: the translation (herdr socket ⇄ app contract), stable session
ids (herdr pane ids change on cross-workspace moves), the attention/inbox
derivation, plugin RPC execution, attachment files on disk, and push triggers. It
manages no processes and keeps no lifecycle ledger — a closed pane simply
disappears from the app.

**The relay core owns**: envelope routing by header, one-use scoped tickets,
file-backed user-operated pairing/revocation when enabled, replay/offline
buffering, and terminal/preview pipes. Its public API is capability-based:
`localAuthority`, `developmentApi`, `advertiseMdns`, and `publicEdge`; deployment
brands do not exist in core. An embedding process may add its own authority and
edge policy without changing relay routing. Non-development
session/RPC and terminal channels require strict v2 ciphertext; the relay checks
bounded routing context and never parses plaintext.

**The app owns**: rendering and local persistence only. No truth lives on the
phone.

## Model mapping

| app concept | herdr | call |
|---|---|---|
| machine | the host running `herdr server` | `ping`, `session.snapshot` |
| session | **a pane with an agent in it** | `agent.list`, `pane.list` |
| session.start | workspace-per-cwd → tab → `agent.start` | `workspace.create` / `tab.create` / `agent.start --kind` |
| session.prompt | submit text to the agent | `agent.prompt` |
| session.abort | interrupt | `agent.send_keys esc` |
| session.stop | close the pane | `pane.close` |
| status | `idle · working · blocked · done · unknown` | `pane.agent_status_changed` |
| inbox / attention | blocked → needs you, done → finished | derived host-side |
| live view | terminal frames over the `/terminal` channel | CLI `herdr terminal session control` (interactive, `--takeover`) / `observe` (read-only previews) |

Sessions you started at your desk show up on the phone too — anything herdr
detects becomes a session row. That is the point of a multiplexer backend.

## Facts worth knowing (verified against herdr 0.8.0)

- **The socket answers one request per connection**, then closes. Only
  `events.subscribe` holds a socket open — one subscribe per socket; a second
  interleaves acks with events. `apps/host/src/herdr/socketClient.ts` opens a
  connection per request, one batch subscription socket, and one filtered socket
  per pane for status.
- **Filtered subscription kinds reject the whole batch.** `pane.agent_status_changed`
  needs a `pane_id`; including it in the batch errors everything (with an
  invisible `id:""` error frame) and zero events flow. Status transitions ride
  per-pane sockets (`watchPaneStatus`).
- **There are no raw `terminal.*` socket methods.** Frames come from the CLI:
  `herdr terminal session control <pane>` emits NDJSON with base64 ANSI. One subprocess
  per attached channel (`apps/host/src/herdr/terminalManager.ts`).
- **`control` resizes the real PTY** (measured: 23×53 → 35×110); `observe` does not.
  Control is single-owner, so attaching takes over input from the desk; preview
  cards use `observe` exactly so the desk is never disturbed.
- **herdr repaints the whole screen in its first frames.** The relay buffers those
  until the client connects, or the terminal opens blank.
- **Pane ids change on cross-workspace moves** and agent names are user-renameable, so
  the host mints its own `pp_<hex>` session ids and keeps a map
  (`apps/host/src/herdr/identity.ts`), updated on `pane.moved`.
- **`done` means "idle and you haven't looked yet."** herdr clears it when the tab is
  focused — which would yank the desk user's focus — so opening the session in the app
  is the "seen" signal instead.
- **`unknown` never means success.** It renders as its own state, never as done.

## The herdr-native surface

Beyond the session basics, the host exposes herdr's topology to the app:

- `herdr.tree` — workspaces → tabs → panes with agent kind/status/title and the
  muxr session id for panes hosting agents. Powers the Herd screen's spaces cards.
- `herdr.layout` — a tab's split rects (terminal cells), so the grid view renders
  the real BSP layout instead of guessing.
- `pane.split` — split any session's pane; with `kind`, an agent starts in the new
  pane. The multiplexing primitive: two agents side by side, one tab.
- `session.start` with `kinds[]` — squad mode: one tab per kind, same workspace,
  started together.
- `SessionInfo` carries `workspaceId`/`tabId`/`workspaceLabel`, `terminalTitle`
  (OSC title breadcrumb), and worktree provenance; `session.updated` events push
  changes so cards and rows refresh live.

## Attachments and changes

Lists are plugin RPC, not session events. The attachments plugin reads the pane
dump dir; the changes plugin runs `git status` in the session cwd. The phone
`item-list` primitive shows names only. Tap uses kernel download tickets or the
file viewer. Large bytes never enter the JS thread. The host still watches
`~/.muxr/attachments/pane/<HERDR_PANE_ID>/` so `attachment.prepare` / fetch / read
can serve a file the plugin listed.

## Push notifications

The local fixture retains Web Push quick actions. Hosted notifications never
synthesize a plaintext answer: they open the native app, which sends the normal
strict-v2 encrypted request after ticket/grant checks.

## What the relay does

The same private Node process serves `/activate`, the control API, readiness,
and WebSockets. Production identity state uses a dedicated MongoDB database.
Long-lived scoped credentials are sent only in HTTP Authorization headers to
mint 60-second, one-use, machine/role/transport/channel-scoped tickets; hosted
WebSockets consume only those tickets.

The relay reads bounded `envelope.header` routing context and treats `payload` as
opaque `e2ee:v2` ciphertext. Terminal frames stay off replay on the separate
`/terminal` pipe, but use the same strict context/ciphertext contract. Hosted
`/preview` is rejected by client, host, ticket API, and relay.

## Not built

- **Per-agent transcript adapters** stay out by design — the terminal is the source
  of truth.
- **iOS-native push surface** (Live Activity, watch) is out of scope; Web Push covers
  Android/desktop browsers and PWAs.
