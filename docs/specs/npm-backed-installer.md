---
title: npm-backed curl installer
slug: npm-backed-installer
status: tested
created: 2026-08-20
updated: 2026-08-20
owner: umer
links:
  - ../../install.sh
  - ../RELEASING.md
---

# npm-backed curl installer

## Context

muxr is a Node application distributed as `@trymuxr/cli`. npm should remain the canonical versioned package and updater source, but first-time users also expect a downloadable shell installer. A second native distribution, bundled Node runtime, or custom package manager would duplicate npm ownership and make updates harder to reason about.

## Decision

Ship one reviewed POSIX `install.sh` at repository root and expose it through GitHub raw content. The script delegates to the same npm package with lifecycle scripts disabled.

The installer:

- supports Linux and macOS hosts;
- requires Node 22+ and npm already on PATH;
- never installs Node, never invokes another remote installer, and never uses `sudo`;
- accepts only a bounded version/tag token;
- installs `@trymuxr/cli@<version>` with `--global --ignore-scripts`;
- validates exactly `<npm-prefix>/bin/muxr`, never a stale binary elsewhere on PATH;
- identifies a stale `muxr` earlier on PATH and tells users to put the installed prefix first before handing off;
- ends by directing the user to the existing guided `muxr` setup.

Documentation downloads the script completely to a `mktemp` file before execution. `curl | sh` is intentionally not shown because a truncated pipeline can execute partially and report the wrong status.

`muxr update` uses the same `--ignore-scripts` policy and refuses to update when the active package belongs to a different npm global root. Users must re-enter the Node version-manager environment that installed muxr instead of silently updating another prefix.

## Files

- `install.sh` — canonical wrapper.
- `scripts/diagnostics/application/checkInstallScript.mjs` — one flow smoke with fake Node/npm, stale PATH binary, whitespace prefix, old Node, injection, and npm permission failure.
- `scripts/release/application/updateCli.mjs` — lifecycle-script and active-prefix parity.
- `scripts/release/application/pack.mjs`, `scripts/deployWebExport.sh` — copy the canonical script into the browser/web artifact.
- README, self-hosting, release, clean-room, and npm docs — one consistent install policy.

## Verification

- [x] `sh -n install.sh` passes.
- [x] Focused installer smoke installs into a whitespace prefix, ignores stale PATH muxr, rejects Node 21 and version injection, and gives no-sudo prefix guidance.
- [x] Real isolated registry install of published `@trymuxr/cli@0.1.11` completes and reports the installed version.
- [x] Workspace TypeScript build passes.
- [x] Full installed-package smoke passes, including updater prefix mismatch and `--ignore-scripts` assertions.
- [x] Packed web artifact contains `web/install.sh` copied from the canonical root file.
- [x] Independent security/distribution review findings are repaired; no unresolved code-level blocker remains.

## Rollback

Remove the documented convenience URL and `install.sh`; npm installation and `muxr update` remain the canonical supported path. Keep updater `--ignore-scripts` and active-prefix checks because they harden npm installs independently of the wrapper.

## Revisions

- 2026-08-20 — Replaced the initially proposed `trymuxr.com/install.sh` endpoint after review proved that URL is not deployed by this repository. GitHub raw `main/install.sh` is published by the same reviewed source merge; release verification byte-compares it to the repository file.
- 2026-08-21 — Fable review: moved PATH repair guidance before handoff, named the stale binary, required prefix-first ordering, and isolated the README cleanup trap in a subshell.
