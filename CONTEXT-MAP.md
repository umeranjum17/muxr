# Context Map

muxr is one product with several bounded contexts. The glossary lives in [CONTEXT.md](./CONTEXT.md). Package ownership lives in [packages/README.md](./packages/README.md); operations are mapped in [USE_CASES.md](./USE_CASES.md), [packages/USE_CASES.md](./packages/USE_CASES.md), and [apps/mobile/sources/USE_CASES.md](./apps/mobile/sources/USE_CASES.md).

## Contexts

- [Herd](./packages/README.md#herd): Agent identity, Agent Lifecycle, Attention, Lifecycle Events, and session snapshots.
- [Control plane](./packages/README.md#control-plane): Envelope routing, client/host requests, preview/terminal sockets, and encrypted session-log DTOs.
- [Peer](./packages/README.md#peer): Peer Allowlist, Peer Mutation, and Device Grant constraint shape.
- [Plugins](./packages/README.md#plugins): Plugin Identity, manifests, and public plugin context.
- [Realtime](./packages/README.md#realtime): Provider-neutral voice frames and the public Agent map that may cross a stream process.
- [Worktree](./packages/README.md#worktree): Worktree Landing outcomes.
- [E2EE](./packages/README.md#e2ee): Device Grant, Pairing Code, v2 Envelope seal/open, and peer descriptors.

## Relationships

- **Herd → Plugins / Realtime**: public snapshots copy Agent Route, Agent Name, Task Title, and Agent Lifecycle; only Agent Route authorizes.
- **Control plane → Herd / Peer / Plugins / Worktree**: requests and host frames name those types; they do not re-decide their invariants.
- **Peer → E2EE**: Device Grant crypto enforces Peer Allowlist constraints already decided in Peer.
- **Control plane → E2EE**: grant-backed Envelope headers (`envelopeIsHosted`) map once onto v2 context; Routing Channel is shared vocabulary.
- **E2EE → Peer / Control plane / shared**: crypto imports those context entry points, not the contract mega-barrel.
- **Realtime → Control plane**: the voice socket URL is the same relay reachability rule as terminal and preview.

## Mobile UI contexts

Phone features under `apps/mobile/sources/`. Tree and public entries: [apps/mobile/sources/README.md](./apps/mobile/sources/README.md). Named operations: [apps/mobile/sources/USE_CASES.md](./apps/mobile/sources/USE_CASES.md).

- **Herd**: Agent rows, live terminals, focus, lifecycle watch from the phone
- **Spawn**: Start Agent, dock, Worktree landing
- **Pairing**: Pair Machine, Reconnect Machine (shared with runtime)
- **Plugins / Terminal / Preview / Takeover / Collaboration / Changelog / Settings**: phone chrome and host-backed surfaces

## Mobile runtime contexts

- [Catalog](./apps/mobile/sources/catalog/CONTEXT.md): Agents as listed work, host DTO mapping, transcript envelopes
- [Watch](./apps/mobile/sources/watch/CONTEXT.md): Lifecycle Events, Agent Watch, Voice Reports
- [Connection](./apps/mobile/sources/connection/CONTEXT.md): grant-backed vs local Connection
- [Pairing](./apps/mobile/sources/pairing/CONTEXT.md): Pairing String, Device Grant, device crypto
- [Conversation](./apps/mobile/sources/conversation/CONTEXT.md): realtime call, mic ownership, desk focus
- [Playback](./apps/mobile/sources/playback/CONTEXT.md): Realtime Playback, Stream Generation, Output Drain
- [Account](./apps/mobile/sources/account/CONTEXT.md): Account Credential, independent of any grant

Encryption primitives under `apps/mobile/sources/encryption/` are a shared kernel, not a context.

Application operations: [apps/mobile/sources/USE_CASES.md](./apps/mobile/sources/USE_CASES.md).

## Relationships

- **Catalog → Watch**: the catalog store hosts the Agent Watch snapshot; Lifecycle Event predicates are Watch language used when mapping Agent rows
- **Catalog → Pairing / Connection**: transport starts only when a Device Grant authorizes the Connection's machine id
- **Catalog → Account**: account session validation is independent of the grant
- **Watch → Conversation**: Voice Reports speak through an active realtime call
- **Conversation → Playback**: the call owns Realtime Playback for one stream generation
- **Conversation → Watch / Catalog / Connection**: desk focus and mic claim read Agent Route and Connection
- **Account → Pairing**: transport authorization uses machine id on the Device Grant, never a display name
- **Pairing → Connection**: restoring a grant may rewrite the active Connection to match the grant

## Tooling contexts


- [Setup](./scripts/setup/README.md): Machine identity, pairing, Self-host Connection, Ingress, daemon, wizard, doctor
- [Plugin](./scripts/plugin/README.md): Plugin Id, bundled catalog, clone, npm registry, `muxr plugin`
- [Release](./scripts/release/README.md): pack the npm CLI and update an installed package
- [Diagnostics](./scripts/diagnostics/README.md): flow checks, doctor entry, diagnostics dump
- Bundled Herdr plugins (`plugins/*`): Voice Report, Provider Secret, Inbox lifecycle, workspace tree. Herdr invokes `rpc.mjs` / `stream.mjs` at the plugin root.

## Relationships

- **CLI → named use cases**: `scripts/cli.mjs` is a composition root. It parses argv/menus and calls named application functions through each context's public index.
- **Setup → Plugin (public)**: linking bundled plugins reads Plugin Id from the plugin public index
- **Release → Setup / Plugin trees**: pack copies compiled context folders into the npm artifact
- **Diagnostics → Setup (public)**: self-host and Tailscale checks call setup use cases through the public index
- **Plugin clone → Voice**: cloned adapters vendor `../voice/*` files so they stay self-contained
