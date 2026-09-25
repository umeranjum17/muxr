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
it mounts slots and draws widgets. Realtime voice, usage and machine health,
dictation, the terminal key row, the workspace tree, and Panes are product code,
not plugins. The phone no longer has a separate in-conversation Browser surface:
on a machine with a desktop session, agents open pages in its desktop browser
and the user watches through Computer. The host still answers the preview
transport for older phone builds; plugins do not expose a preview action.
Navigation destinations open `/plugin`.

The app registers widgets (`item-list`, `collection`, `icon-button`, …), not
plugin ids, and plugins compose only those widgets. No path permits downloaded
React.

The normative protocol, trust chain, failure cases, rollback, and extraction
boundary are in [decision 0005](decisions/0005-pi-like-extension-runtime.md).
The approachable author guide is [Build a muxr plugin](PLUGINS.md).

## Ownership boundaries

**herdr owns**: processes, panes, workspaces, tabs, layouts, agent detection,
lifecycle state, scrollback, worktrees. If herdr doesn't know about it, it doesn't
exist.

**The host owns**: the translation (herdr socket ⇄ app contract), stable session
ids (herdr pane ids change on cross-workspace moves), the attention/inbox
derivation, plugin RPC execution, attachment files on disk, push triggers, and the
on-demand desktop engine process it starts and stops for one authorized session. It
manages no agent processes and keeps no lifecycle ledger — a closed pane simply
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
phone. A machine-scoped, display-only Home snapshot in local MMKV holds the last
host-confirmed tree and agent presentation until both a fresh tree and catalog
arrive. It is not an authority for terminal previews or close actions; sign-out,
removed grants, and web secure-store reset clear it.

## Model mapping

| app concept | herdr | call |
|---|---|---|
| machine | the host running `herdr server` | `ping`, `session.snapshot` |
| session | **a pane with an agent in it** | `agent.list`, `pane.list` |
| session.start | workspace-per-cwd → tab → `agent.start` | `workspace.create` / `tab.create` / `agent.start --kind` |
| session.prompt | submit text to the agent | `agent.prompt` |
| session.abort | interrupt | `agent.send_keys esc` |
| session.stop | close the selected live Agent Route through an explicit pane → tab → workspace → worktree-group ladder | host close ladder (`agentClose.ts`) on the live Herdr socket; live revalidation and confirmation for every broader scope |
| pane.close | close only the selected pane | `pane.close`; refuse if its tab could not remain |
| tab.close | close only the selected tab | `tab.close`; refuse if its workspace could not remain |
| workspace.close | close only the selected workspace | `workspace.close`; refuse if its worktree group would also close |
| herdr.rename | rename an agent, pane, tab or workspace in Herdr, which owns every name | `agent.rename` / `pane.rename` / `tab.rename` / `workspace.rename`, then refresh the snapshot (Herdr announces no agent or pane rename) |
| Close worktree group | final explicit scope of `session.stop`, after its own confirmation | revalidate the parent workspace, then call Herdr `workspace.close`; Herdr has no separate group-close method |
| status | `idle · working · blocked · done · unknown` | `pane.agent_status_changed` |
| inbox / attention | blocked → needs you, done → finished | derived host-side |
| live view | terminal frames over the `/terminal` channel | CLI `herdr terminal session control` (interactive, `--takeover`) / `observe` (read-only previews) |

Sessions started at the desk show up on the phone once Herdr publishes their
agent session (often after the first turn). Detection alone is not a session:
the host rechecks missing sessions when pane status changes and after the
per-pane status watch is acknowledged, even if an older snapshot was in flight.

## Facts worth knowing (verified against herdr 0.8.0)

- **The socket answers one request per connection**, then closes. Only
  `events.subscribe` holds a socket open — one subscribe per socket; a second
  interleaves acks with events. The host's
  [`socketClient.ts`](../apps/host/src/agent/infrastructure/socketClient.ts) opens a
  connection per request, one batch subscription socket, and one filtered socket
  per pane for status.
- **Filtered subscription kinds reject the whole batch.** `pane.agent_status_changed`
  needs a `pane_id`; including it in the batch errors everything (with an
  invisible `id:""` error frame) and zero events flow. Status transitions ride
  per-pane sockets (`watchPaneStatus`).
- **There are no raw `terminal.*` socket methods.** Frames come from the CLI:
  `herdr terminal session control <pane>` emits NDJSON with base64 ANSI. One subprocess
  per attached channel
  ([`terminalManager.ts`](../apps/host/src/agent/infrastructure/terminalManager.ts)).
- **`control` resizes the real PTY** (measured: 23×53 → 35×110); `observe` does not.
  Control is single-owner, so attaching takes over input from the desk; preview
  cards use `observe` exactly so the desk is never disturbed.
- **herdr repaints the whole screen in its first frames.** The relay buffers those
  until the client connects, or the terminal opens blank.
- **Pane ids change on cross-workspace moves** and agent names are user-renameable, so
  the host mints its own session ids and keeps a map, updated on `pane.moved`.
- **`done` means "idle and you haven't looked yet."** herdr clears it when the tab is
  focused — which would yank the desk user's focus — so opening the session in the app
  is the "seen" signal instead.
- **`unknown` never means success.** It renders as its own state, never as done.

## The herdr-native surface

Beyond the session basics, the host exposes herdr's topology to the app:

- `herdr.tree` — workspaces → tabs → panes with agent kind/status/title and the
  muxr session id for panes hosting agents, plus each workspace's creation
  `order`, its bounded display-only producer `tokens`, and its worktree
  `repoKey`/`linked`. Powers the Herd screen's spaces cards: a workspace whose
  lineage is declared — a `parent` token, or Herdr's worktree group (a linked
  checkout under the unlinked workspace sharing its `repoKey`) — folds inside
  its top-level ancestor's card, nested one step under the workspace that
  spawned it, beneath a quiet group subheader, instead of getting a card of its
  own; the card header is the single disclosure control. Families with four or
  more descendants default to a tappable one-line count and status summary;
  live defaults follow family size, but a person's explicit open or close wins.
  Search keeps a matching descendant's spawning chain visible. A cycle or a
  parent missing from the tree makes a card, never hides one. Labels are never
  parsed to guess lineage; display names drop a drawn `└` prefix and an opaque
  ` · p:<token>` correlator, and name path labels by their folder. Only names
  visible in the current list are disambiguated; a close confirmation identifies
  the selected workspace by name and its worktree/root path, or by host.
- `herdr.layout` — a tab's split rects (terminal cells), still served for
  layout-aware callers; the tab grid and pane overview render uniform cards
  from `herdr.tree` with snapshot previews instead of the BSP geometry.
- `pane.split` — split any session's pane; with `kind`, an agent starts in the new
  pane. The multiplexing primitive: two agents side by side, one tab.
- `session.start` with `kinds[]` — squad mode: one tab per kind, same workspace,
  started together.
- `SessionInfo` carries `workspaceId`/`tabId`/`workspaceLabel`, `terminalTitle`
  (OSC title breadcrumb), and worktree provenance; `session.updated` events push
  changes so cards and rows refresh live.

## Shared Artifacts and changes

Shared Artifacts is product-owned per-session history over the pane's watched
dump directory. `artifact.list` returns a bounded metadata-only snapshot and
`artifacts.update` publishes that same newest-first view when the watcher
changes; neither metadata path carries bytes. Previews can use `artifact.fetch`;
current app downloads use bounded `artifact.read` chunks (up to 512 KiB each)
on the encrypted RPC path. The host directs each chunk response to the requesting
socket, and the relay neither replays nor buffers it. The older one-time local
download ticket endpoint remains for installed clients but is not the current
app's download path. The phone groups entries chronologically and reuses the
image gallery and rich document previews. Neither filesystem paths nor pane/session
ids are rendered.

Downloads show progress and keep partial bytes for a later tap or resume after
reconnection. Native downloads write to a cache file and open the finished file
with the system (the installer for Android APKs). Web downloads use the origin's
private file system and hand completed files to the browser download manager;
if the page is hidden at completion, a durable private file can be saved on
return, including after a reload. Without private-file-system access, web
falls back to memory for files up to 64 MiB: Save reuses those bytes only until
reload, then offers a new download. Larger files need private-file-system
access. Partial downloads expire after seven days and are cleared on pairing
change or removal.

"Artifact" is the whole vocabulary here, host and phone alike: types, files,
filesystem modules and protocol methods. Two things keep an older spelling on
purpose, because nothing on the other side can be told to change:

- `attachment.list`, `attachment.fetch`, `attachment.prepare` and
  `attachment.read` remain wired to the same host handlers, with the old
  `attachmentId` param and the old `attachments` listing field. A host answers
  them for an app built before the rename; the current app falls back to the
  list, fetch and read aliases after a `host-contract-mismatch` and remembers
  the answer.
- `attachments.update` is published beside `artifacts.update` from the same
  publish site, carrying the same `total` and `truncated` under the old
  `attachments` field, so a pre-rename app's open timeline still updates live.
  It stays out of `SESSION_EVENT_TYPES`: a canonical client never waits for it.
  Delete it with the request aliases above.
- `~/.muxr/attachments/pane/`, the `attachment` hosted routing channel, the
  `/v1/attachment-download` route with its `attachmentId` query key, and the
  plugin vocabulary (`muxr.attachments`, plugin action `type: "attachment"`)
  are contracts with installed tooling, the cleartext envelope, and approved
  plugin manifests. See [CONTEXT.md](../CONTEXT.md).

The extracted attachments plugin remains wire-compatible during migration. The
changes surface separately runs host-owned git requests in the session cwd.

Retention bounds that history. The host sweeps once a day and removes only
files that entered a pane *after* retention was installed on that machine, so
the pile that already existed is left alone and unbounded disk growth stops
without an automatic purge. Scope and age are judged by the inode change time —
when a file entered the pane — so a recording an agent moves in keeps its place
however old its modification time is; the newest-first order the phone shows
stays on the modification time. Within that scope: the newest 50 files of a pane
are exempt from the count bound, nothing younger than a week is touched at all,
and nothing post-install survives a month or pushes a pane past 512 MiB of
removable files.
The sweep stats names and never reads a byte — hashing this root costs 17 GiB of
I/O — and writes what it removed, under which policy, to
`$MUXR_HOME/artifact-retention.json`. The captain's tree was measured at
**39 GB / 21,491 files / 258 pane directories** and stays as it is until he runs
`muxr artifacts prune`, which applies the same policy to the existing history
after showing him the plan.

## Push notifications

Notifications open the app, which sends the normal strict-v2 encrypted
request after ticket/grant checks. They never synthesize a plaintext answer.

## What the relay does

The same Node process on your machine serves pairing, readiness, and WebSockets.
Long-lived scoped credentials mint 60-second, one-use tickets; the existing
muxr WebSockets consume only those tickets. On a self-host relay,
`@byokit/relay` also serves optional
`/relay/v1/*` and `/link/v1/<host id>` routes beside the existing muxr routes.
The host uses its existing machine box key and enrolls native phones from its
`selfhost.json` device records through `@byokit/link`; browsers, terminal and
preview streams, and remote desktop still use the existing relay transport.
The link checks the live device table for requests (including cached replies)
and broadcasts, so revocation and role changes do not wait for grant sync.
On startup, the host enrolls its existing devices before opening its link relay
connection. A role change replaces the link grant and closes the old socket;
the phone reconnects in the new role without losing its pairing or showing
`removed`. Revocation still removes access. If link relay state cannot load,
the existing relay continues without those routes. Pairing stays on the
existing transport. For a self-host machine, a paired phone moves its session
channel onto the link without re-pairing: the host enrols it from its device
records and appends the enrolled link key to its `herdr.tree` replies
(re-announced whenever the link relay comes online), and the phone then dials
`/link/v1/<host id>` with the keys it already holds, keeping the relay
transport open as a fallback. Hosted relays keep phones on the relay transport.

The relay reads bounded `envelope.header` routing context and treats `payload` as
opaque `e2ee:v2` ciphertext. Terminal frames stay off replay on the separate
`/terminal` pipe, but use the same strict context/ciphertext contract.

## Not built

- **Per-agent transcript adapters** stay out by design — the terminal is the source
  of truth.
- **Push-started or push-updated iOS Live Activities and watch delivery** are not
  built. In-app Live Activities are implemented; see [iOS feature parity](specs/ios-feature-parity.md).
