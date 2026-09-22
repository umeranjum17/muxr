# Plugin

Owns Plugin Id, create/check/dev/install/call, and the npm/git registry used by `muxr plugin`.

## Tree

```
scripts/plugin/
  index.mjs                 public entry
  domain/                   Plugin Id and bundled validation
  application/              checkPlugin, installPlugin, and the other `muxr plugin` operations
  infrastructure/           packed-vs-checkout path resolution
```

## Aggregates

**Plugin Id** is the only identity used to link, enable, or remove a plugin. Folder names are paths.

**Plugin Id** keys each installed package, not its folder name. muxr ships no bundled add-ons: every product surface, including realtime voice, is product code.

Setup retracts a previous release's bundled add-ons by id: only ids in its legacy bundled list whose registration still points at a `plugins/` directory. A plugin linked from elsewhere, and an id muxr never shipped, are left untouched.

## Invariants

- Provider choice is preserved across setup and package upgrades.
