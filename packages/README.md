# packages

`@muxr/contract` is the domain language. `@muxr/crypto` is the E2EE context that seals it. Apps import the package barrels or a context entry (`@muxr/contract/herd`). They must not import context internals.

## Tree

```
packages/
  checkArchitecture.mjs
  contract/src/
    index.ts                         public barrel
    selfCheck.ts
    shared/                          Outcome (expected rejection)
    herd/{index.ts,domain/}
    control-plane/{index.ts,domain/,infrastructure/}
    peer/{index.ts,domain/}
    plugins/{index.ts,domain/,infrastructure/}
    realtime/{index.ts,domain/}
    worktree/{index.ts,domain/}
  crypto/src/
    index.ts                         public barrel
    selfCheck.ts
    e2ee/{index.ts,domain/,infrastructure/}
```

No presentation layer: these packages have no React or controllers. No application folder: parsers and use-case adapters sit in the context that owns the DTO (`plugins/infrastructure/manifest.ts`, `control-plane/domain` client frames).

Dependency direction: domain is pure TypeScript; infrastructure may import same-context domain; a context may import another context only through its `index.ts`. Contract never imports crypto. `packages/checkArchitecture.mjs` rejects the reverse and nested ternaries.

## Herd

**Owns**: Agent, Agent Route, Human Name, Task Title, Provider Kind, Agent Lifecycle, Lifecycle Event, Attention, session snapshot.

**Invariants**:
- Agent Route is the only key that authorizes prompt, watch, or focus. Human Name and Task Title never do.
- `working` is the only busy lifecycle; when herdr reports a lifecycle it outranks the streaming flag.
- Waiting Attention never ages out. Done ages out after ten minutes. Everything except waiting dies after six hours.
- Public Agent Routes (plugin/stream boundaries) are a subset of host-internal routes.

## Control plane

**Owns**: Envelope, Routing Channel, client/host frames, request map, preview/terminal/ticket URLs, encrypted session-log DTOs.

**Invariants**:
- The relay reads only the Envelope header. Payload is opaque.
- Routing Channel is the same vocabulary as E2EE context.
- Client frames fail closed at the parse boundary (`tryParseClientFrame` / `parseClientFrame`).
- Session-sync Zod schemas are transport DTOs, distinct from live Session Events.

## Peer

**Owns**: Peer Allowlist, Peer Mutation, Device Kind, grant constraint shape.

**Invariants**:
- A request with no matching capability is denied.
- Peer Device Grants cannot carry broad authority. Native/browser grants cannot carry peer constraints.
- Start requires signed directories. Directories without start are rejected.
- Peer Mutations expire; a window past the hard TTL plus clock skew is invalid.

## Plugins

**Owns**: Plugin Identity, manifest graph, public plugin context, compatibility.

**Invariants**:
- Plugin Identity authorizes link/invoke/invalidation. Display names never do.
- Unknown slots are skipped; known slots with invalid fields throw.
- Localized text and dynamic screens declare a minimum UI version.

## Realtime

**Owns**: realtime frames, PCM16 admission, the public session map that may leave the host process.

**Invariants**:
- Only a parsed public Agent Route and Human Name cross the stream boundary.
- Task titles are stripped of provider/name prefixes and secret-like text before crossing.

## Worktree

**Owns**: Worktree Landing.

**Invariants**:
- Landing never deletes the worktree directory.
- `blocked-dirty-base` needs consent. `landed` and `already-landed` succeeded. Conflict is neither.

## E2EE

**Owns**: Device Grant, Pairing Code, v2 Envelope, signed peer descriptors, install bundles.

**Invariants**:
- Open fails closed on cleartext, tamper, replay, context mismatch, and wrong key.
- Peer grants never carry control/observe authority.
- Pairing Code is ten unambiguous characters; the spoken code is not a credential after pairing.
- Hosted Envelope headers map once onto v2 context; local/dev headers have no hosted context.
