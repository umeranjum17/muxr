# Plugin

Owns Plugin Id, the bundled catalog, clone/create/check/dev, and the npm/git registry used by `muxr plugin`.

## Tree

```
scripts/plugin/
  index.mjs                 public entry
  domain/                   Plugin Id, bundled enablement, retired successors
  application/              checkPlugin, clonePlugin, installPlugin, and the other `muxr plugin` operations
  infrastructure/           packed-vs-checkout path resolution
```

## Aggregates

**Plugin Id** is the only identity used to link, enable, clone, or remove a plugin. Folder names are paths.

**Bundled Plugin** keys optional voice adapters by Plugin Id (`muxr.voice-openai`, `muxr.voice-gemini`), not folder name.

Retired plugins remember a successor Plugin Id so setup can unlink the old folder.

## Invariants

- Clone destinations stay outside the packed npm artifact.
- Clone vendors `../voice/*` imports so a copied adapter stays self-contained.
- Optional adapters stay disabled until the owner chooses them.
