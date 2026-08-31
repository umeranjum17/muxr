# Plugin

Owns Plugin Id, the bundled catalog, clone/create/check/dev, and the npm/git registry used by `muxr plugin`.

## Tree

```
scripts/plugin/
  index.mjs                 public entry
  domain/                   Plugin Id and bundled validation
  application/              checkPlugin, clonePlugin, installPlugin, and the other `muxr plugin` operations
  infrastructure/           packed-vs-checkout path resolution
```

## Aggregates

**Plugin Id** is the only identity used to link, enable, clone, or remove a plugin. Folder names are paths.

**Bundled Plugin** keys each package by Plugin Id, not folder name. Realtime voice is one `muxr.voice` package with provider adapters under `plugins/voice/providers/`.

Setup removes registrations that still point at deleted direct children of its own bundle directory; plugins linked from elsewhere are untouched.

## Invariants

- Clone destinations stay outside the packed npm artifact.
- Clone output stays self-contained.
- Provider choice remains plugin-owned state across setup and package upgrades.
