# Architecture

Herdr owns agents and backend plugins, the host translates, the relay routes
bytes, and the app draws the terminal. The app is a native extension shell:
host-installed packages contribute approved native surfaces without downloaded code.

```
  PHONE / WEB               RELAY                   YOUR MACHINE
  apps/mobile               apps/relay              apps/host          herdr server
  ─────────────             ─────────               ──────────         ────────────
  terminal + herd UI  ◄──► routes link frames   ◄──► translates    ◄──► owns the PTYs
  owns no truth             sees ciphertext        contract ⇄          detects agents
                            blind link routing      herdr socket        resumes them
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
just any program that parses those bytes into pixels: Ghostty on the phone,
herdr's built-in emulator, xterm.js on web. The clients draw from the same
stream, but each uses its own renderer.

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
                  └─→ kit terminal session per channel
                      (base64 ANSI frames) → byokit link stream via relay → phone
                      → Ghostty (native) or xterm.js (web) draws its own copy
```

Keystrokes travel the reverse path: phone → link → host → herdr → PTY → the
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
a muxr-launched pane's own browser, emulator, or claimed simulator appears as a live chip while it
is there, and on a machine with a desktop session, agents can also open pages
in its desktop browser for the user to finish through Computer. Plugins do not expose a preview action.
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
derivation, plugin RPC execution, attachment files on disk, push triggers, the
preview presence it measures from a pane's own screen or its pane-owned
headless emulator (adb discovery) or a pane-claimed iOS Simulator (vendored idb,
macOS), and the on-demand desktop
engine processes it starts and stops — the computer's screen for one authorized
viewer, or a pane's screen for an agent preview. It manages no agent processes
and keeps no lifecycle ledger — a closed pane simply disappears from the app.

**The relay core owns**: blind `@byokit/relay` link routing, push registration,
shared-relay machine enrollment and readiness/web serving. The host owns pairing
approval and device authority; `@byokit/link` encrypts phone/host traffic with
Noise IK. The relay cannot read session, terminal or stream payloads. See
[the cutover contract](specs/byokit-cutover.md).

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
| session.start | workspace-per-cwd → tab → agent in the selected pane | `workspace.create` / `tab.create` / kit `startAgent` with `place: { pane }` and the pane's cwd (home directory fallback) |
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
| live view | terminal frames over a link stream | kit `TerminalSession` (`control` with takeover / `observe` read-only previews) |

Sessions started at the desk show up on the phone once Herdr detects the agent
kind on the pane. A pane Herdr detected but has not published a session for
yet (Codex 0.159 publishes none) stands in on a pane route the host adopts
onto the real session when it arrives. The host rechecks missing sessions
when pane status changes and after the per-pane status watch is acknowledged,
even if an older snapshot was in flight.

## Facts worth knowing (verified against herdr 0.9.1)

- **The socket answers one request per connection**, then closes. Only
  `events.subscribe` holds a socket open — one subscribe per socket; a second
  interleaves acks with events. The kit owns this: the host's
  [`herdrKitClient.ts`](../apps/host/src/agent/infrastructure/herdrKitClient.ts)
  (`KitHerdrClient`) keeps one batch subscription socket and one filtered socket
  per pane for status, over `@byokit/herdr`.
- **Filtered subscription kinds reject the whole batch.** `pane.agent_status_changed`
  needs a `pane_id`; including it in the batch errors everything (with an
  invisible `id:""` error frame) and zero events flow. Status transitions ride
  per-pane sockets (`watchPaneStatus`).
- **There are no raw `terminal.*` socket methods.** Frames come from a kit
  terminal session (`source.herdrTerminal`, one `TerminalSession` per attached
  channel), which emits herdr's own NDJSON terminal protocol — the only
  host-generated frame is `terminal.ready`. The kit owns the herdr binary and env.
- **`control` resizes the real PTY** (measured: 23×53 → 35×110); `observe` does not.
  Control is single-owner, so attaching takes over input from the desk; preview
  cards use `observe` exactly so the desk is never disturbed.
- **herdr repaints the whole screen in its first frames.** The link path queues
  frames arriving before the attach result and sends them to the phone after
  attach succeeds.
- **Pane ids change on cross-workspace moves** and agent names are user-renameable, so
  the host mints its own session ids and keeps a map, updated on `pane.moved`.
- **`done` means "idle and you haven't looked yet."** herdr clears it when the tab is
  focused — which would yank the desk user's focus — so opening the session in the app
  is the "seen" signal instead.
- **`unknown` never means success.** It renders as its own state, never as done.

## The herdr-native surface

Beyond the session basics, the host exposes herdr's topology to the app:

- `herdr.agentKinds` — the host agent catalog; see
  [`RequestMap`](../packages/contract/src/control-plane/domain/requests.ts) for
  the wire fields and [`AgentCatalog`](../apps/host/src/requests/application/agentCatalog.ts)
  for sign-in privacy and refresh semantics.
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
- `herdr.layout` — a tab's split rects (terminal cells); the tab grid and pane
  overview are its layout-aware callers, drawing the tab's real split from it.
- `pane.split` — split any session's pane; with `kind`, an agent starts in the new
  pane. The multiplexing primitive: two agents side by side, one tab.
- `session.start` with `kinds[]` — squad mode: one tab per kind, same workspace,
  started together.
- `SessionInfo` carries `workspaceId`/`tabId`/`workspaceLabel`, `terminalTitle`
  (OSC title breadcrumb), worktree provenance, and `preview` when the agent is
  showing a watchable browser or emulator on its pane's own screen, or a
  simulator the pane claimed. The host stamps `session.created` and
  `session.updated` events, including cumulative reconnect replay, with the same
  device-or-screen preview as session lists; a device preview takes precedence
  over the pane's screen, so lifecycle updates do not clear its chip.

## Shared Artifacts and changes

Shared Artifacts is product-owned per-session history over the pane's watched
dump directory. `artifact.list` returns a bounded metadata-only snapshot and
`artifacts.update` publishes that same newest-first view when the watcher
changes; neither metadata path carries bytes. Previews can use `artifact.fetch`;
current app downloads use bounded `artifact.read` chunks (up to 512 KiB each)
on the encrypted RPC path. The host directs each chunk response to the requesting
link, and the relay neither replays nor buffers it. A separate one-time local
HTTP download ticket remains for original artifact bytes; it is not a relay
transport fallback. The phone groups entries chronologically and reuses the
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
  `attachmentId` param and the old `attachments` listing field. The current app
  can fall back to the list, fetch and read aliases after a
  `host-contract-mismatch`; this does not restore pre-cutover wire compatibility.
- `attachments.update` is published beside `artifacts.update` from the same
  publish site, carrying the same `total` and `truncated` under the old
  `attachments` field for product-contract compatibility.
  It stays out of `SESSION_EVENT_TYPES`: a canonical client never waits for it.
  Delete it with the request aliases above.
- `~/.muxr/attachments/pane/` and the plugin vocabulary (`muxr.attachments`,
  plugin action `type: "attachment"`) remain contracts with installed tooling
  and approved plugin manifests. See [CONTEXT.md](../CONTEXT.md).

The extracted attachments plugin retains its product request aliases. The
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

Notifications open the app; requests travel over the authenticated link.
A blocked agent's alert names it and carries its question; the native Answer
action, "Answer in muxr", opens muxr to send one key as `session.answer` over
the link, and the host types it only while that alert's blocked event is still
the one waiting. A browser notification, including the installed iPhone web app,
has no reply field, so answering there is platform-limited and its tap opens the
agent.

The host seals each lifecycle notice separately to the recipient's raw device
box key using `@byokit/seal`. Task title, agent name, a blocked agent's question,
event kind and machine/session scope stay inside the sealed notice; the relay and push provider receive generic
alert text and ciphertext. Clients open notices with stored paired grants and
fall back to generic text when opening fails. The browser service worker reads
paired grants through `pairing/infrastructure/webSecureStore.ts` to open notices;
approval still runs in the app over the authenticated link. Native pre-display
decryption is not implemented; see [notification presentation](../README.md).
Browser taps carry decrypted scope in the `/notification` URL fragment, never
an HTTP query, and the app checks the originating machine before navigation.

## What the relay does

`@byokit/relay` routes encrypted link frames between the phone (native or web)
and host via `/link/v1/<host id>` and `/relay/v1/host`. It also handles push and
shared-relay enrollment; no muxr ticketed socket, ciphertext replay log, or
fallback transport remains. The host checks live device authority on link
requests and broadcasts; a pending pairing grant is admitted only during its
approval window and becomes durable after proof over the machine's real link.
Revocation closes the device link without rotating a shared data key. Older app
builds and pre-cutover pairings must update and pair again. For connection
routes and pairing instructions, see [Self-hosting](SELF-HOSTING.md).

## Not built

- **Per-agent transcript adapters** stay out by design — the terminal is the source
  of truth.
- **Push-started or push-updated iOS Live Activities and watch delivery** are not
  built. In-app Live Activities are implemented; see [iOS feature parity](specs/ios-feature-parity.md).
