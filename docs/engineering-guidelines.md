# Engineering guidelines

How to keep muxr clean, small and safe to change. These sit on top of the
module-first rules in [CONTRIBUTING.md](../CONTRIBUTING.md) and the glossary in
[CONTEXT.md](../CONTEXT.md); where those files are more specific, they win.
Most points are review judgement, not CI rules.

## 1. Ownership and dependency direction

- Keep the module-first topology: domain is pure, application coordinates an
  intent, infrastructure owns I/O, and the router (`app/`) or host/relay root
  composes.
- Across features and modules, import only the documented public entries.
  Contract never imports crypto. The relay holds no keys.
- A new bidirectional feature or module edge is a failed check, not a request
  to widen the allowlist.
- A stable route or key authorizes. A display name never does.

## 2. Size is a review trigger, not a quota

- Aim for at most **400** authored lines per file and **80** per function.
- At **600 / 120**, the PR says why the next edit cannot extract one cohesive
  behavior.
- Exempt: generated translations, contract and schema tables, declarative JSX,
  and composition modules where a split would hide a lifecycle.
- Do not apply the limits retroactively, and never split a file only to meet a
  number. Reducing state owners and branches beats moving lines around.

## 3. Naming and design

- Use `CONTEXT.md` terms. Name use cases for their intent in camelCase; name
  component files in PascalCase.
- One use case per real operation. No `services/`, `BaseEntity`, DI container,
  single-method interface, compatibility shim or speculative configuration.
- Prefer built-ins and native behavior. When you replace code, delete the old
  code.

## 4. Errors and security at boundaries

- Validate input at HTTP, WebSocket, plugin and native boundaries. Unauthorized
  requests fail closed.
- Expected domain failures stay explicit typed outcomes
  (`{ ok: false, reason }`). Diagnostics carry bounded context but never echo
  tokens, private paths or provider secrets.
- Never silently swallow an error that can leave persisted state or a session
  lifecycle stale. A best-effort error may be swallowed with a comment giving
  the reason.
- Put a timeout on network calls, bound queues and buffers, and check who owns
  a stream and who cleans it up.

## 5. Mobile state and lifecycles

- The remote machine and Herdr are the authority. Screen-local state is
  transient UI state; persisted settings and grants go through their existing
  owner modules.
- Each terminal, voice or preview lifecycle has one owner, which cleans up on
  blur, unmount and reconnect.
- Zustand selectors return stable values: no inline `?? []` or `?? {}`.
- Check fixed chrome on the 270 dp short viewport described in
  [AGENTS.md](../AGENTS.md#screens).

## 6. Checks and tests

- Ordinary PRs run `yarn run check:fast`; run the full `yarn run check` when it
  is safe to. Plain `yarn check` is Yarn's own, different command.
- After native dependency changes, run the native-patch check
  (`verifyNativePatches.mjs`) and the typecheck.
- Default to zero new tests. For a credible shipped regression, add one real
  flow across modules, extending an existing flow where you can. Crypto and
  security keep their adversarial coverage.
- A test must go red when the behavior it claims to cover breaks. A skipped
  live-Herdr test does not count as a passing integration.

## 7. Automate incrementally

- Keep the existing architecture ratchets and strict TypeScript.
- Before widening import checks, add a negative fixture, built on the TypeScript
  AST already installed, for one real blind spot.
- Duplicate and dead-export scanners may be trialled for information only, with
  explicit route, plugin and public-API exemptions and a human-reviewed
  baseline. Promote only the rules that prove low-noise.
- No new blanket lint or size check until it prevents a real, repeated error.

## Standing decisions

- **Line limits do not fail CI.** 400 / 80 are review prompts. The exceptions
  are real, and blanket quotas breed artificial indirection.
- **No new static-analysis dependencies for now.** Use the installed TypeScript
  AST first. Scanners such as knip or jscpd run only as non-blocking
  measurements, and only if someone owns their exemptions.
- **No mass rewrite of the existing mobile feature cycles.** The 11 pairs in
  `apps/mobile/sources/architecture.spec.ts` are a ratchet that may only
  shrink. Remove one pair per feature PR, verified at product level.
