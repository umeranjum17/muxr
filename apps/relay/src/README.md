# Relay runtime

Envelope pipe. Composition lives at `main.ts` / `relay.ts` / `httpHandlers.ts`.

## Tree

```
src/
  main.ts relay.ts httpHandlers.ts config.ts index.ts
  platform/                      private file persist
  admission/{domain,application,infrastructure}/
  routing/{domain,application,infrastructure}/
  push/{infrastructure}/
```

Each context exposes `index.ts`. Other contexts import that file, not internals.

## Aggregates and invariants

**Peer Identity** (`admission/domain`): ticket admission always carries `transport`. Loopback query-string admission has no transport and lives in the `local` tenant. Display names never admit a socket.

**Envelope route** (`routing/domain`): delivery vs tenant-mismatch vs target-unavailable is decided from delivered count and whether another tenant can see the Machine. The relay never opens `envelope.payload`.

**Push** has infrastructure only: web push, webhook, mail. No invented domain layer.

Loopback WS query-string admission and `machinetok_` stay live for the local harness and probe.
