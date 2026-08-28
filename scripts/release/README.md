# Release

Owns assembling the self-hostable npm artifact and updating an already-installed CLI.

## Tree

```
scripts/release/
  index.mjs                 public entry
  application/              pack, update
  infrastructure/           license audit of bundled dependencies
```

Pack copies compiled setup/plugin/release/diagnostics trees (JavaScript only), rewrites the plugin contract import for the packed layout, and stamps the hosted control URL.
