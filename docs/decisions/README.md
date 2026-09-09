# muxr product decisions

Product behavior must not be an accidental framework default or an implementation detail. Umer remains the decider.

## Tiers

| Tier | Scope | Decision | Evidence |
|---|---|---|---|
| T0 | Implementing an already-accepted rule; no behavior change | Normal code review | Existing gate |
| T1 | Reversible UI detail: spacing, icon, local copy, animation | One coherent batch before release | Screenshot/emulator capture + named UI/accessibility precedent |
| T2 | Workflow, onboarding, default, feature boundary, vocabulary | Individual decision record | Alternatives + affected states + emulator or precedent |
| T3 | Security, authority, pairing, protocol, persisted/transmitted data, privacy, and destructive behavior | Two-key approval plus an explicit owner decision | Failure scenario + rollback + live/flow check |

Use the highest applicable tier. A small diff can still be T3. Applying an accepted design token is T0; choosing the token is T1/T2.

## Lenses

- **Fit — does this belong?** Product fit, comprehension, workflow, accessibility, architecture, and simpler alternatives.
- **Hold — does this hold?** Integration states, reconnect/restart/offline behavior, abuse, compatibility, and executable validation.

A block must cite a concrete user harm, failure scenario, muxr invariant, WCAG/Nielsen/platform rule, OWASP/privacy principle, protocol compatibility rule, or store requirement. Preference is a non-blocking note.

A record is accepted, accepted with notes, or needs changes (maximum three concrete blockers).

## Artifacts

- T1 batches: `docs/decisions/batches/YYYY-MM-DD-surface.md`, maximum ten related items.
- T2/T3: `docs/decisions/NNNN-slug.md`, one decision per file.
- Chat transcripts are evidence, not the source of truth.

A decision record contains: decision, alternatives, standards/evidence, resolved constraints, owner decision, validation, rollback/reopen trigger, and revisions.

## Reopening

Observed evidence outranks prior consensus. A reproducible emulator/live-stack failure or credible user report reopens the affected decision. Reopen only what the evidence contradicts; do not reopen unrelated architecture. Security/privacy/data behavior reverts to the prior safe state while a reopened T3 decision is unresolved.
