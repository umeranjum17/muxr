## What

Derive the muxr.control marketplace manifest from the canonical manifest shipped in @trymuxr/cli. The published check-copy.mjs --write command generates the mirror's installed-package runner paths; check-copy.mjs rejects missing or drifted manifests. The canonical launcher keeps its local runner paths.

## Why

Keep the launcher definition in one source while supporting both plugin layouts. Copying the canonical manifest verbatim into muxr-herdr would leave every CLI action and pane pointing at a missing root run.mjs.

## Risk

- Classification: low
- Rationale: canonical launcher behavior is unchanged; only marketplace generation and verification change.

## Release impact

This is preparatory work. The mirror check is not already enforced. A queued follow-up in umeranjum17/muxr-herdr will enable the check on pull requests and pushes after the CLI release containing this verifier publishes. This change does not edit that external repository.

## Verify

The package smoke flow now exercises the published generator, verifies its output, executes a generated status command from the marketplace layout, and rejects drift. The review phase performs one focused launcher verification; package-wide validation remains owned by the outer pipeline.
