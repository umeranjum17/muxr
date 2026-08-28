# Mobile UI contexts

The phone app is split by what the person is doing, then by layer. Expo Router files under `app/` stay the composition root. Shared chrome (`components/`, `modal/`, `theme`, `text`) is not a fake context.

## Tree

```
apps/mobile/sources/
  app/                          composition root (Expo Router)
  herd/
    domain/                     Agent, Herd lifecycle, row presentation, spaces tree
    application/                live terminals, resume eligibility, session identity
    presentation/               home scan, list, spaces, sidebar
    index.ts                    domain + use cases
    ui.ts                       screens
  spawn/
    domain/                     SpawnRequest, WorktreeSelection
    application/                startNewAgent, dock environment, drafts
    infrastructure/             git worktree RPCs
    presentation/               HomeDock, directory picker
    index.ts                    domain + use cases
    ui.ts                       screens
  pairing/
    domain/                     PairedMachine, ConnectionStatus
    application/                pairing hooks, relay discovery
    infrastructure/             MuxrClient
    presentation/               connection chrome, QR
    index.ts                    domain + use cases
    ui.ts                       screens
  plugins/
    domain/                     screen/collection/tree models (untrusted host UI)
    application/                catalog, actions, events
    presentation/               declarative screens and slots
    index.ts                    domain + use cases
    ui.ts                       screens
    callPlugin.ts               frozen public port for voice/realtime
    openPluginStream.ts         frozen public port for voice
  terminal/
    domain/                     TerminalLink, file links, status bar
    application/                open terminal, chip probe, recent output
    presentation/               live terminal screen
    index.ts                    domain + use cases
    ui.ts                       screens
  collaboration/
    domain/                     Collaboration mesh
    application/                setup/disconnect orchestration
    infrastructure/             scoped machine client
  preview/  takeover/  changelog/  settings/
  components/ hooks/ utils/ modal/  shared chrome
```

Frozen shims (`utils/herd.ts`, `hooks/useNewSessionDraft.ts`, `plugins/callPlugin.ts`, …) exist because excluded runtime (`sync/`, `realtime/`, `voice/`, `auth/`) must keep its import paths.

## Ubiquitous language

See root `CONTEXT.md`. Agent Route authorizes. Human Name, Task Title, and computer display names never authorize.

## Aggregates and invariants

- **Agent**: `Agent.lifecycle()` is the only status the herd, live row, and notifications may show. Live thinking beats a stale `done` word. Display names are never keys.
- **Herd**: blocked Agents first; notification `eventKey` uses Agent Routes, never spoken names.
- **SpawnRequest**: reject empty kinds, empty directory, or duplicate Human Names before `session.start`.
- **WorktreeSelection**: picker keys `__none__` / `__new__` / path; only the path is a checkout.
- **PairedMachine**: `active` is online; display name is chrome.
- **TerminalLink**: loopback + `text/html` probe → Preview; otherwise open externally.
- **Collaboration**: two to six machines, or none. Machine ids authorize.

## Dependency direction

Outsiders import `@/<context>` for domain and use cases, or `@/<context>/ui` for screens. Never `@/<context>/domain/…`. Domain is pure TypeScript (type-only React types allowed). Named operations are listed in `USE_CASES.md`. `architecture.spec.ts` rejects forbidden direction, presentation on public barrels, nested ternaries in domain/use cases, and UI imports in named use cases.


## Mobile runtime contexts

Feature-first bounded contexts. Layers exist only where they hold real code. Old `@/sync`, `@/state`, `@/realtime`, `@/voice`, and `@/auth` paths remain public entry points for UI outside this scope.

## Tree

```
apps/mobile/sources/
  catalog/{domain,application,infrastructure}
  watch/{domain,application}
  connection/{application}
  pairing/{domain,application,infrastructure}
  conversation/{domain,application,infrastructure,presentation}
  playback/{infrastructure}          # native sink: modules/voice-overlay
  account/{domain,application,infrastructure,presentation}
  encryption/                        # shared crypto kernel
```

## Aggregate ownership

| Aggregate / VO | Owner | Invariants |
|---|---|---|
| Agent | catalog/domain | Agent Route (session id) authorizes. Human Name / Task Title never route. Quiet Agents stay listed for 30 minutes. Blocked Agents carry an open approval. Catalog refresh must not clobber live lifecycle. |
| Session envelope | catalog/domain | Turnless agent envelopes drop unless they are a usage heartbeat. |
| Lifecycle Event | watch/domain | Human alerts are blocked, failed, or done. Routine voice is idle or done. `lifecycleStateSince` is the last state change, not the last tick. |
| Voice Report | watch/domain | Parse fails closed. Spoken Human Name must not be an internal id. Agent Route + identity authorize. |
| Agent Watch | watch/application | Scope is machine-keyed. Invalid reports never persist. |
| Pairing String | pairing/domain | Constructors reject control characters, spoofed userinfo, and non-muxr URLs. Unknown authority defaults to control. Display name never authorizes. |
| Hosted Grant | pairing/domain | Machine id authorizes transport. No key-version downgrade. Web defaults to observe. Grant, not discovery, owns authority. |
| Connection | connection/application | Hosted persists an empty machine id for account-only sessions. Local is the explicit dev fixture. |
| Mic Ownership | conversation/domain | Dictation, realtime, and VAD never own the mic together. |
| Realtime Playback | playback/infrastructure | Drain acks bind to Stream Generation. Replacement streams do not ack previous audio. |
| Account Credential | account/domain | Independent of Hosted Grant. Empty proof is unavailability. 401 is rejection, not unavailability. Fetch stays in application. |

## Dependency direction

Domain is pure TypeScript. Application orchestrates. Infrastructure maps host/relay/native DTOs once. Presentation owns React. Cross-context code imports the context `index.ts` (or the legacy public entry), never another context's `domain/` / `application/` / `infrastructure/` / `presentation/` files.
