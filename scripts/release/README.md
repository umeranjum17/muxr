# Release

Owns assembling the self-hostable npm artifact and updating an already-installed CLI.

## Tree

```
scripts/release/
  index.mjs                 public entry
  application/              packRelease script, updateCli
  infrastructure/           license inventory of bundled dependencies
```

`prepareChangelog` selects the one authored entry for a release's app version and renders the offline HTML report and Markdown release body deterministically; `presentation/changelog.mjs` exposes `validate`, `generate` and `check`. Ownership of the notes and the evidence rules live in `docs/RELEASING.md`.

Pack copies compiled setup/plugin/release/diagnostics trees (JavaScript only), rewrites the plugin contract import for the packed layout, and stamps the optional packaged control URL.
