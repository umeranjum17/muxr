# packages

`@muxr/contract` exists so host, mobile, relay, and plugins use one implementation of cross-process wire shapes, admission and limit rules, and invariant vocabulary. It is the compatibility boundary between processes, not a general utility package. Apps import its public barrel or a focused entry point such as `@muxr/contract/herd`; they do not import context internals.

Code belongs in `@muxr/contract` when multiple processes must agree on its exact shape or rule: wire envelopes and request maps, boundary admission, shared limits, and vocabulary whose meaning must not drift. Mobile parsing or presentation, host adapters, single-consumer transport DTOs, storage models, crypto implementation, and convenience helpers do not belong here.

The name is deliberate. **Contract** says callers depend on an enforced cross-process agreement. **Shared** would invite unrelated reusable code, **core** would imply a central dependency bucket, and **protocol** would be too narrow for admission, limits, and invariant vocabulary that are not byte-level protocol.

`@muxr/crypto` similarly provides one shared implementation of E2EE envelopes, authenticated context, replay rejection, and device/peer grant rules for the endpoints that seal or open payloads. The relay does not import it: the relay routes on envelope headers while encrypted payloads remain opaque, so it does not own keys, open payloads, or enforce replay and grant policy.

Navigate by intent in [USE_CASES.md](./USE_CASES.md). Glossary: [CONTEXT.md](../CONTEXT.md). Contributor rules: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Tree

```
packages/
  USE_CASES.md
  checkArchitecture.mjs
  contract/src/
    index.ts                         public barrel
    selfCheck.ts
    shared/                          Outcome (expected rejection)
    herd/{index.ts,domain/}
    control-plane/{index.ts,domain/,application/,infrastructure/}
    peer/{index.ts,domain/,application/}
    plugins/{index.ts,domain/,application/,infrastructure/}
    realtime/{index.ts,domain/,application/}
    worktree/{index.ts,domain/,application/}
  crypto/src/
    index.ts                         public barrel
    selfCheck.ts
    e2ee/{index.ts,domain/,application/,infrastructure/}
```

No presentation layer: these packages have no React or controllers. Application exists only for named operations the package owns. There is no `services/` folder. `issueWsTicket` stays infrastructure because it uses HTTP.

Dependency direction: domain is pure TypeScript; application may import same-context domain and infrastructure; infrastructure may import same-context domain; a context may import another context only through its `index.ts`. Contract never imports crypto. `packages/checkArchitecture.mjs` rejects the reverse, nested ternaries, fake DDD types, and application modules missing from `USE_CASES.md`.

## Herd

**Owns**: Agent, Agent Route, Agent Name, Task Title, Provider Kind, Agent Lifecycle, Lifecycle Event, Attention, session snapshot.

**Invariants**:
- Agent Route is the only key that authorizes prompt, watch, or focus. Agent Name and Task Title never do.
- `working` is the only busy lifecycle; when herdr reports a lifecycle it outranks the streaming flag.
- Waiting Attention never ages out. Done ages out after ten minutes. Everything except waiting dies after six hours.
- Public Agent Routes (plugin/stream boundaries) are a subset of host-internal routes.

Start / prompt / watch / focus are host and mobile adapters over this domain (`session.start`, `session.prompt`, `agent.watch`, `pane.focus`).

## Control plane

**Owns**: Envelope, Routing Channel, client/host frames, request map, preview/terminal/ticket URLs.

**Invariants**:
- The relay reads only the Envelope header. Payload is opaque.
- Routing Channel is the same vocabulary as E2EE context.
- Client frames fail closed at `admitClientFrame` (`tryParseClientFrame` / `parseClientFrame` remain adapter aliases).

## Peer

**Owns**: Peer Allowlist, Peer Mutation, Device Kind, grant constraint shape.

**Invariants**:
- A request with no matching capability is denied (`authorizePeerDispatch`).
- Peer Device Grants cannot carry broad authority. Native/browser grants cannot carry peer constraints.
- Start requires signed directories. Directories without start are rejected.
- Peer Mutations expire; a window past the hard TTL plus clock skew is invalid (`admitPeerMutation`).

## Plugins

**Owns**: Plugin Identity, manifest graph, public plugin context, compatibility.

**Invariants**:
- Plugin Identity authorizes link/invoke/invalidation. Display names never do.
- Unknown slots are skipped; known slots with invalid fields throw.
- Localized text and dynamic screens declare a minimum UI version.

`parsePluginManifest` is the named use case; throwing `parseManifest` remains the catalog adapter.

## Realtime

**Owns**: realtime frames, PCM16 admission, the public session map that may leave the host process.

**Invariants**:
- Only a parsed public Agent Route and Agent Name cross the stream boundary (`boundRealtimePublicContext`).
- Task titles are stripped of provider/name prefixes and secret-like text before crossing.

## Worktree

**Owns**: Worktree Landing.

**Invariants**:
- Landing never deletes the worktree directory.
- `blocked-dirty-base` needs consent. `landed` and `already-landed` succeeded. Conflict is neither.
- `interpretWorktreeLanding` turns that result into the next human-facing decision.

## E2EE

**Owns**: Device Grant, Pairing Code, v2 Envelope, signed peer descriptors, install bundles.

**Invariants**:
- Open fails closed on cleartext, tamper, replay, context mismatch, and wrong key.
- Peer grants never carry control/observe authority.
- Pairing Code is ten unambiguous characters; the spoken code is not a credential after pairing.
- Hosted Envelope headers map once onto v2 context; local/dev headers have no hosted context.
