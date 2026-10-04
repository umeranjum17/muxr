# Constraints

Last reviewed: 2026-10-04

## Floor (always enforced)

- No new checker suppressions: `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, `biome-ignore`, `# noqa`, `# type: ignore`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`, `Stryker disable`
- No unimplemented stubs or empty `catch {}` blocks
- No skipped or deleted tests without a reason in the commit message; the
  suite diet that removed redundant coverage is the precedent, and security,
  crypto and data-loss paths keep their coverage regardless
- No secrets in source
- This file does not get weakened to make a change pass

Checked on every pull request by the existing suite:

- The diff-scoped floor guard `scripts/diagnostics/application/checkFloor.mjs`
  (merge base to working tree, tracked/staged/untracked) runs in the
  `check:fast` lane owned by `scripts/diagnostics/application/runSuite.mjs`.
  It reports rule, path and line only.
- The whole-tree secret scan `scripts/diagnostics/application/checkNoSecrets.mjs`
  runs in the full suite (`yarn run check`).

Widen this file only with dimensions that name the command that produces the
verdict; a number with no command is an aspiration, not a constraint.
