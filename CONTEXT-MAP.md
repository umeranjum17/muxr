# Context Map

muxr is one product with several bounded contexts. The glossary lives in [CONTEXT.md](./CONTEXT.md). Ownership, invariants, and the package tree live in [packages/README.md](./packages/README.md). Named operations live in [packages/USE_CASES.md](./packages/USE_CASES.md).

## Contexts

- [Herd](./packages/README.md#herd): Agent identity, Agent Lifecycle, Attention, Lifecycle Events, and session snapshots.
- [Control plane](./packages/README.md#control-plane): Envelope routing, client/host requests, preview/terminal sockets, and encrypted session-log DTOs.
- [Peer](./packages/README.md#peer): Peer Allowlist, Peer Mutation, and Device Grant constraint shape.
- [Plugins](./packages/README.md#plugins): Plugin Identity, manifests, and public plugin context.
- [Realtime](./packages/README.md#realtime): Provider-neutral voice frames and the public Agent map that may cross a stream process.
- [Worktree](./packages/README.md#worktree): Worktree Landing outcomes.
- [E2EE](./packages/README.md#e2ee): Device Grant, Pairing Code, v2 Envelope seal/open, and peer descriptors.

## Relationships

- **Herd → Plugins / Realtime**: public snapshots copy Agent Route, Human Name, Task Title, and Agent Lifecycle; only Agent Route authorizes.
- **Control plane → Herd / Peer / Plugins / Worktree**: requests and host frames name those types; they do not re-decide their invariants.
- **Peer → E2EE**: Device Grant crypto enforces Peer Allowlist constraints already decided in Peer.
- **Control plane → E2EE**: hosted Envelope headers (`envelopeIsHosted`) map once onto v2 context; Routing Channel is shared vocabulary.
- **E2EE → Peer / Control plane / shared**: crypto imports those context entry points, not the contract mega-barrel.
- **Realtime → Control plane**: the voice socket URL is the same relay reachability rule as terminal and preview.
