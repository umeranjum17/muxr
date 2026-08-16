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
host (`node apps/host/dist/main.js --fake`) drives a scripted agent so mobile work
needs no real agents.

Dev loop: `yarn up` (relay + host), then the app dev server per the
[README](README.md). `yarn doctor` diagnoses a stack that will not come up.
The unsupported local relay fixture lives in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md); local Android builds live in
[docs/NATIVE-BUILD.md](docs/NATIVE-BUILD.md).

## Verify before you push

```bash
node scripts/runSuite.mjs
```

That is the same gate CI runs. After native dependency changes also run
`node scripts/verifyNativePatches.mjs`. If you changed the contract, run the
probe — it asserts every event type survives the wire end to end:

```bash
node apps/probe/dist/main.js
```

## The rules that keep this codebase small

1. **One vocabulary.** The app speaks herdr's words: herd, agents, workspaces
   ("spaces"), tabs, panes. Don't introduce chat-era concepts (sessions-as-chats,
   model pickers, thinking levels) into the UI. Pi is the only coding-agent
   provider presented as supported by muxr.
2. **herdr owns processes.** No lifecycle bookkeeping in the host or app — no
   archival ledgers, no tombstones, no reaping. If herdr says a pane is gone, it's
   gone. New capabilities start from herdr's API, not from shadow state.
3. **Agent-agnostic features only.** The backend must never read per-agent
   internals (transcript files, per-agent hooks, per-agent config). Features work
   through git, the herdr socket, or directory conventions — never through
   provider-specific internals.
4. **The contract ripples.** Adding a session event type means updating
   `packages/contract/src/sessionEvent.ts`, `sessionState.ts`, `index.ts`,
   `selfCheck.ts`, and `apps/host/src/fakeSessionSource.ts` together — the
   self-checks assert full coverage and fail otherwise. Requests likewise: one
   `RequestMap` entry + one dispatcher handler, or both sides stop compiling.
   Plugin primitive changes ripple through `PRIMITIVE_SPECS`,
   `primitiveRegistry.tsx`, `MUXR_UI_VERSION`, `docs/PLUGINS.md`, and the bundled
   plugin index/check.
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

- `packages/wire` — private app wire schemas
- `packages/contract` — the host/mobile contract vocabulary
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
