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

