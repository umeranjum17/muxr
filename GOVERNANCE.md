# Governance

## How decisions get made

muxr is a single-maintainer project. Umer Anjum is the decider. There is no
committee, no vote, and no implied consensus process. Contributions are welcome;
the decision to merge or to set direction stays with the maintainer.

## Decision records

Architectural and product decisions are recorded as ADRs in
[docs/decisions/](docs/decisions/). The process is described in
[docs/decisions/README.md](docs/decisions/README.md): decisions are tiered by
impact (T0 through T3), and security, authority, pairing, protocol, persisted
data, privacy, and destructive behavior (T3) require two-key approval plus an
explicit owner decision. Chat transcripts are evidence, not the source of
truth; the record is the ADR.

## Extending the plugin vocabulary

The declarative plugin vocabulary is closed and additive-only. Additions must
not break or reinterpret existing manifests. New UI slots require an ADR before
implementation, because a slot is a trust surface, not a styling choice.

## What to contribute

In order of most to least welcome:

1. **Plugins.** The plugin system is where most ideas belong. See
   [docs/PLUGINS.md](docs/PLUGINS.md).
2. **Docs.** Corrections, clarifications, and worked examples.
3. **Core.** Small, and only after an ADR or maintainer agreement in an issue.

## What will be declined

PRs that add downloaded-code execution on the phone (JS bundles, WebViews,
remote renderers) will be declined on principle, regardless of implementation
quality. The declarative shell is the defense against hostile plugin code
reaching the device. If your idea needs code on the phone, it is not a fit for
this project.
