# Inspect and prune Shared Artifacts history

A user reads what the daily retention sweep is doing to their Shared Artifacts
timeline and deliberately clears the old pile that predates retention — never
silently: `status` shows policy and last sweep, `prune` always shows its plan
first.

## Sub-features

- `retention-status` prints the policy and the last sweep/prune records.
- `prune-plan` `prune` (and `prune --dry-run`) prints what would be removed.
- `prune-apply` `prune --yes` removes exactly the planned files.
- `prune-nothing` a pane inside policy prints `Nothing to prune: …`.

## How to get to it (user POV)

- Run `muxr artifacts` (or `muxr artifacts status`) to see the policy.
- Run `muxr artifacts prune` to plan, then answer, or `prune --yes` to apply.

## Driving it with the private stack

Preconditions:

- Baseline stack from `../SKILL.md`; ideally one or more files already shared
  into a pane (see [shared-artifact](./shared-artifact.md)) so the timeline is
  non-empty.

- **Status on a fresh home.** `node scripts/cli.mjs artifacts status` exits `0`,
  prints `Shared Artifacts retention`, the four policy lines
  (`keeps the newest …`, `removes past that when …`, `removes regardless when …`,
  `per-pane ceiling …`, `sweeps every …`), and
  `No sweep has run on this machine yet. The host starts one a few minutes after it boots.`
- **Status after sharing.** After sharing files, status still reports policy;
  the pane directory listing is the ground truth for what is stored.
- **Prune with nothing old.** `node scripts/cli.mjs artifacts prune --yes`
  exits `0` printing `Nothing to prune: every pane is already inside the retention policy.`
  (freshly shared files are inside policy — retention only removes old files).
- **Plan is shown first.** `prune` without `--yes` prints the plan and asks;
  `prune --dry-run` prints the plan plus `--dry-run: nothing was removed.` and
  the pane directory is unchanged afterwards (`ls` before/after).

## Gotchas

- `status` reads `$MUXR_HOME/artifact-retention.json`; an unreadable report
  pauses sweeps (exit `1` with a repair hint) — that is a loud stop, not corruption.
- Prune considers pre-retention files only via `epochMs: 0`; it never removes
  files the policy would keep. Do not force deletion by editing the report.
- The scheduled sweep belongs to a running host; on a `--fake` host with no
  long uptime, "no sweep has run yet" is expected, not a failure.
