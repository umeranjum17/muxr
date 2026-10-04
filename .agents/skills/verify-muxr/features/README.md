# muxr verification map

This directory is the maintained source for verifying the user-facing behavior
of muxr's self-hosted relay/host and public CLI. Read this index before
driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Follow `../SKILL.md` Launch so the stack is private: task-owned
  `MUXR_HOME`, relay on a kernel-picked port learned from the child's stdout,
  host on `--fake`, naming on a private port.
- Every CLI call is `node scripts/cli.mjs …` from the repo root with the same
  `MUXR_HOME`. Treat commands as literal; keep quoted names and flags
  unchanged.
- `muxr doctor`-style checks pass (`/health` ok, version matches, one online
  host). Never drive an instance this run did not start.
- For pane-scoped commands, run inside a Herdr pane of a non-default session
  you own, so `HERDR_PANE_ID` arrives the way every real pane gets it.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say
  otherwise.
- Prefer public flags and running services over internal state: no mocks, no
  test-only endpoints, no editing files under `MUXR_HOME` to force a result.
- Capture the command, its stdout/stderr/exit code, and the durable side
  effect through a second read-only user-facing view.
- Report a skipped entry point with the attempted command and the unmet
  precondition; never report it as verified through a different path.

## Proof and skip reporting

- Mutation proof always pairs the action (CLI output) with the stored result
  (`$MUXR_HOME` paths, relay owner API listings).
- Failure-path proof includes the exact failing input, its stderr, and exit
  code 1 — a missing target must fail loudly, not silently.
- Evidence lives outside the scratch `RUN_ROOT` and survives cleanup.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior, then exactly four H2 sections in this order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with the private stack`
(starting with `Preconditions:`), and `Gotchas`.

## Features

- [Share a file into a pane's Shared Artifacts](./shared-artifact.md) —
  `muxr share`, collision suffixes, dotfile rename, missing-target failure,
  versioned page shares and their refusals, and the retention view of the
  same timeline.
- [Check the self-host](./selfhost-health.md) — relay `/health`, version
  identity, and the owner-only hosts listing.
- [Name the current workspace and pane](./agent-naming.md) — `muxr name`
  inside a Herdr pane, with provider/model attribution.
- [Inspect and prune Shared Artifacts history](./artifact-retention.md) —
  `muxr artifacts status` / `prune`.
- [Ask whether the phone is driving this pane](./preview-status.md) —
  `muxr preview status` against the naming loopback.
