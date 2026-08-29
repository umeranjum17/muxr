# Mobile UI contexts

The phone app is split by what the person is doing, then by layer. Expo Router files under `app/` stay the composition root. Shared chrome (`components/`, `modal/`, `theme`, `text`) is not a fake context.

Named operations live in [USE_CASES.md](./USE_CASES.md). One application module per real operation; adapters invoke those modules.

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
    domain/                     PairedMachine, Pairing String, Hosted Grant
    application/                UI pairing + runtime claim/restore/forget
    infrastructure/             MuxrClient, secret stores
    presentation/               connection chrome, QR
    index.ts                    domain + use cases
    ui.ts                       screens
    e2ee.ts                     Hosted Grant adapters
    secrets.ts                  native/web secret stores
  plugins/
    domain/                     screen/collection/tree models (untrusted host UI)
    application/                catalog, actions, events
    presentation/               declarative screens and slots
    index.ts                    domain + use cases
    ui.ts                       screens
    callPlugin.ts               frozen public port for voice
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
  catalog/{domain,application,infrastructure}
  watch/{domain,application}
  connection/{application}
  conversation/{domain,application,infrastructure,presentation}
  playback/{application,infrastructure}   # native sink: modules/voice-overlay
  account/{domain,application,infrastructure,presentation}
  encryption/                        # shared crypto kernel
  USE_CASES.md                       # capability → module → adapters
  components/ hooks/ utils/ modal/  shared chrome
```

## Ubiquitous language

See root `CONTEXT.md`. Agent Route authorizes. Agent Name, Task Title, and computer display names never authorize.

## Aggregates and invariants

- **Agent**: `Agent.lifecycle()` is the only status the herd, live row, and notifications may show. Live thinking beats a stale `done` word. Display names are never keys. Catalog refresh must not clobber live lifecycle. Quiet Agents stay listed for 30 minutes.
- **Herd**: blocked Agents first; notification `eventKey` uses Agent Routes, never spoken names.
- **SpawnRequest**: rejects an empty Agent Kind or directory before `session.start`; pane-titler owns Agent Names.
- **WorktreeSelection**: picker keys `__none__` / `__new__` / path; only the path is a checkout.
- **PairedMachine**: `active` is online; display name is chrome.
- **Pairing String**: constructors reject control characters, spoofed userinfo, and non-muxr URLs. Unknown authority defaults to control.
- **Hosted Grant**: machine id authorizes transport. No key-version downgrade. Web defaults to observe. Grant, not discovery, owns authority.
- **TerminalLink**: loopback + `text/html` probe → Preview; otherwise open externally.
- **Collaboration**: two to six machines, or none. Machine ids authorize.
- **Connection**: hosted persists an empty machine id for account-only sessions. Local is the explicit dev fixture.
- **Mic Ownership**: dictation, realtime, and VAD never own the mic together.
- **Realtime Playback**: drain acks bind to Stream Generation. Replacement streams do not ack previous audio.
- **Account Credential**: independent of Hosted Grant. Empty proof is unavailability. 401 is rejection, not unavailability.

## Dependency direction

Outsiders import `@/<context>` for domain and use cases, `@/<context>/ui` for screens, or a documented public entry (`@/herd/model`, `@/herd/live`, `@/catalog/store`, `@/catalog/sync`, `@/catalog/ops`, `@/catalog/rig`, `@/watch/store`, `@/account/session`, `@/pairing/client`, `@/pairing/e2ee`, `@/pairing/grant`, `@/pairing/secrets`, `@/plugins/events`, `@/conversation/diagnostics`, `@/conversation/session`, `@/playback/interrupt`). Never `@/<context>/domain/…`. Domain is pure TypeScript (type-only React types allowed). Named operations are listed in `USE_CASES.md`. `architecture.spec.ts` rejects forbidden direction, presentation on public barrels, nested ternaries in domain/use cases, removed `sync`/`state`/`realtime`/`voice`/`auth`/`client` shims, and UI imports in named use cases.

`watch/index.ts` is Lifecycle Event and Voice Report language plus the Watch/Report use cases, so catalog domain can import it without loading Agent Watch persistence. `wakeAndReport` stays on `@/watch/application/wakeAndReport`.
