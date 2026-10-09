# Host runtime

The Machine process. `main.ts` handles help before loading the runtime;
composition lives at `runHost.ts` / `host.ts`. Modules own the rest.

## Tree

```
src/
  main.ts                   process entry / help
  runHost.ts host.ts         composition / presentation
  platform/                  Node file IO used by infrastructure
  agent/{domain,application,infrastructure}/
  machine/{domain,infrastructure}/
  peer/{domain,application,infrastructure}/
  requests/{application,infrastructure}/
  diagnostics/{infrastructure}/
  desktop/{domain,application,infrastructure}/
  plans/                          plan accounts: store, identity, auto, sign-in and management
```

Each module exposes `index.ts`. Other modules import that file, not internals.

Use cases: [USE_CASES.md](./USE_CASES.md).

## Aggregates and invariants

**Agent** (`agent/domain`): Agent Route authorizes. Agent Name and Task Title never authorize. Layout snapshots carry Agent Kind, not pane identity as a routing key. Lifecycle rollup is rank, not a display label.

**Device Grant** (`machine/domain`): omitted kind means native. Peer grants observe. Browser without an explicit authority observes. A peer fleet is capped at 16. Observer browser/native grants cannot mutate; peers take the peer admission path instead. Tables overlay runtime keys; display metadata is not in the key.

**Peer start surface** (`peer/domain`): a peer cannot start with parent/worktree/kinds/createCwd/planAccount, and cwd must sit inside approved roots. Prompt/start/watch require a mutation receipt.

**Plan Account** (`plans/`): credential and identity invariants live in [`planStore.ts`](plans/planStore.ts), and OpenCode's private-root rules in [`opencodeAccounts.ts`](plans/opencodeAccounts.ts); the wire contract lives in [`RequestMap`](../../../packages/contract/src/control-plane/domain/requests.ts). User-facing account selection, sign-in and moving are documented in the [README](../../../README.md#switch-between-subscription-accounts).

## Layers

Domain is pure TypeScript. Application orchestrates use cases. Infrastructure maps Herdr sockets, files, and crypto DTOs. No empty layers.
