# Host runtime

The Machine process. Composition lives at `main.ts` / `host.ts`. Contexts own the rest.

## Tree

```
src/
  main.ts host.ts            composition / presentation
  platform/                  Node file IO used by infrastructure
  agent/{domain,application,infrastructure}/
  machine/{domain,infrastructure}/
  peer/{domain,application,infrastructure}/
  requests/{application,infrastructure}/
  diagnostics/{infrastructure}/
```

Each context exposes `index.ts`. Other contexts import that file, not internals.

Use cases: [USE_CASES.md](./USE_CASES.md).

## Aggregates and invariants

**Agent** (`agent/domain`): Agent Route authorizes. Agent Name and Task Title never authorize. Layout snapshots carry Agent Kind, not pane identity as a routing key. Lifecycle rollup is rank, not a display label.

**Device Grant** (`machine/domain`): omitted kind means native. Peer grants observe. Browser without an explicit authority observes. A peer fleet is capped at 16. Observer browser/native grants cannot mutate; peers take the peer admission path instead. Tables overlay runtime keys; display metadata is not in the key.

**Peer start surface** (`peer/domain`): a peer cannot start with parent/worktree/kinds/createCwd, and cwd must sit inside approved roots. Prompt/start/watch require a mutation receipt.

## Layers

Domain is pure TypeScript. Application orchestrates use cases. Infrastructure maps Herdr sockets, files, and crypto DTOs. No empty layers.
