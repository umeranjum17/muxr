# Contributing

muxr is a small, opinionated codebase. This file is the whole contract
between you and it.

## Set up

```bash
git clone https://github.com/umeranjum17/muxr.git
cd muxr
yarn install --frozen-lockfile
yarn build
```

You need Node ≥ 22, yarn 1.x, and — for anything touching the live backend —
[herdr](https://herdr.dev) running (`herdr server`). Without herdr, the fake
host (`yarn host`) drives a scripted agent so mobile work needs no real agents.

Dev loop: `yarn up` (relay + host), then the app dev server with
`cd apps/mobile && yarn start`. `yarn doctor` diagnoses a stack that will not come up.
The unsupported local relay fixture lives in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md); local Android builds live in
[docs/NATIVE-BUILD.md](docs/NATIVE-BUILD.md).

## Verify before you push

The exact check path CI runs:

```bash
yarn check
```

That is `node scripts/runSuite.mjs`. It includes `yarn typecheck`
(`tsc --build --force`), mobile `tsc --noEmit`, package self-checks, and
`node packages/checkArchitecture.mjs`.

After native dependency changes also run `node scripts/verifyNativePatches.mjs`.
If you changed the contract, run the probe — it asserts every event type
survives the wire end to end:

```bash
yarn probe
```

Focused package loop after `@muxr/contract` / `@muxr/crypto` edits:

```bash
yarn typecheck
node packages/checkArchitecture.mjs
node packages/contract/dist/selfCheck.js
node packages/crypto/dist/selfCheck.js
npx vitest run packages/contract --root .
```

## Architecture

Packages are context-first, not layer-first. Read
[packages/README.md](packages/README.md) for ownership and invariants,
[packages/USE_CASES.md](packages/USE_CASES.md) to navigate by intent, and
[CONTEXT.md](CONTEXT.md) for the glossary.

```
packages/contract/src/<context>/{domain,application?,infrastructure?}
packages/crypto/src/e2ee/{domain,application,infrastructure}
```

**Dependency direction.** Domain is pure TypeScript: no tweetnacl, zod, Node,
fetch, React, or sockets. Infrastructure may import same-context domain.
Application may import same-context domain and infrastructure. A context
imports another context only through that context's `index.ts`. Contract never
imports crypto. E2EE imports `@muxr/contract/peer`, `/control-plane`, and
`/shared`, not the contract barrel. Apps import package barrels or context
entries; they must not import `domain/`, `application/`, or `infrastructure/`
paths. `packages/checkArchitecture.mjs` rejects the reverse.

**Ubiquitous language.** Names in code match [CONTEXT.md](CONTEXT.md): Agent,
Agent Route, Human Name, Task Title, Attention, Peer Allowlist, Device Grant,
Envelope, Routing Channel, Plugin Identity, Worktree Landing. Do not invent
synonyms (session-as-chat, display label, IRepository). Public functions keep
those words.

**Use cases.** One intent-revealing `application/<verbNoun>.ts` per real
operation the package owns. Each takes a small command or value object,
coordinates domain entities and ports that already exist, and returns an
explicit result. No transport, UI, or native details. Domain entities decide
invariants and transitions; use cases coordinate them. Routes, React hooks,
socket handlers, CLI commands, and plugins are thin adapters that invoke the
named use case. Do not add a generic `services/` folder, empty handlers, or
one-method ports. If the behavior lives in host or mobile, list it in
`USE_CASES.md` and keep the adapter there.

**Rich domain.** Entities and value objects carry the rules (parse, admit,
expire, authorize). Anemic DTO bags with a service layer that re-implements
those rules are a bug. No `BaseEntity`, generic repositories, or DI container.

**No internal compatibility.** Internals are not an API. When a file moves,
delete the old path. Do not leave shims, dual implementations, or deprecated
internal barrels. Public export names apps already import stay until a
deliberate breaking change; throwing parsers such as `parseClientFrame` and
`openV2` may remain as adapter aliases of the named use case.

**Readability.** No nested ternaries. No boolean piles — extract a named
predicate. Flatten control flow with early returns. `checkArchitecture.mjs`
fails nested ternaries.

**Tests.** Flow-level only. Default to zero new test files. One flow test per
feature is the norm. Heavily mocked tests that would pass if the real code
broke are worse than none. Crypto and security paths keep their coverage.
`apps/mobile/sources/sync/sessionSync.integration.spec.ts` is the reference.
Do not add a test matrix because a brief asked for one.

## The rules that keep this codebase small

1. **One vocabulary.** The app speaks herdr's words: herd, agents, workspaces
   ("spaces"), tabs, panes. Don't introduce chat-era concepts (sessions-as-chats,
   model pickers, thinking levels) into the UI. The app presents whatever agents
   the connected Herdr host reports; don't hardcode one provider's concepts.
2. **herdr owns processes.** No lifecycle bookkeeping in the host or app — no
   archival ledgers, no tombstones, no reaping. If herdr says a pane is gone, it's
   gone. New capabilities start from herdr's API, not from shadow state.
3. **Agent-agnostic features only.** The backend must never read per-agent
   internals (transcript files, per-agent hooks, per-agent config). Features work
   through git, the herdr socket, or directory conventions — never through
   provider-specific internals.
4. **The contract ripples.** Adding a session event type means updating
   `packages/contract/src/herd/domain/sessionEvent.ts`, `sessionState.ts`, the
   herd `index.ts`, `selfCheck.ts`, and `apps/host/src/fakeSessionSource.ts`
   together — the self-checks assert full coverage and fail otherwise. Requests
   likewise: one `RequestMap` entry + one dispatcher handler, or both sides stop
   compiling. Plugin primitive changes ripple through `PRIMITIVE_SPECS`,
   `primitiveRegistry.tsx`, `MUXR_UI_VERSION`, `docs/PLUGINS.md`, and the bundled
   plugin index/check. A new package operation gets one `application/` module and
   a `USE_CASES.md` row, or the architecture check fails.
5. **No LLM tokens in data paths.** Host features are plumbing: git, fs.watch,
   websockets. Never a model call, never anything injected into a watched agent's
   prompt.
6. **Minimal diffs.** Reuse what's here before writing new. No new dependencies
   without a stated reason in the PR. No speculative abstractions. Delete code
   rather than wrap it.
7. **Test user-visible flows, not branches.** Add the smallest flow-level check
   that would catch a shipped regression. Avoid heavily mocked test matrices and
   default to no new test file when an existing flow can carry the assertion.
8. **Stable store selectors (mobile).** Never `?? []` / `?? {}` inline in a zustand
   selector — use a module-level constant. An uncached snapshot is an infinite
   re-render loop in production.

## Where things live

- `packages/contract` — bounded contexts for the host/mobile/relay vocabulary
- `packages/crypto` — E2EE context; the relay never holds keys
- `packages/USE_CASES.md` — capability → use case → domain owner → adapters
- `apps/host` — the herdr bridge; `src/herdr/` is the backend
- `apps/relay` — envelope routing, replay, terminal/preview channels, push
- `apps/mobile` — the app; `sources/terminal/` is the terminal layer
- `docs/ARCHITECTURE.md` — the herdr facts this code depends on; read it before
  touching `apps/host/src/herdr/`

## Proposing changes

Open an issue first for anything that adds a surface (a screen, a request type, an
event). Bug fixes and small improvements can come straight as PRs. Keep PRs
single-purpose; include the verification output in the description.

By submitting a contribution, you agree that the project may distribute it as
part of muxr under the repository's [Apache License 2.0](LICENSE).
Third-party code keeps its original license and attribution.

Sign commits with `git commit -s` (a `Signed-off-by:` trailer). That is the
[Developer Certificate of Origin](DCO.md).

## Reporting bugs

Include: what you tapped, what you expected, what happened, and — if it's a live
behavior — the host log slice (`journalctl --user -u muxr.service`) and whether
`herdr agent list` agrees with what the app showed. The app renders herdr's truth;
half of all "app bugs" are herdr state, and that one comparison settles which.
