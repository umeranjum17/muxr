# muxr demo

The 59-second product film and README feature loops are typeset in Remotion. README screens are source-faithful ports of the shipping mobile components: exact theme tokens, typography, assets, component hierarchy, terminal chrome, and lifecycle language — not screenshots or generic device mockups.

```bash
cd tools/demo
npm install
npm run reel       # raw/muxr-demo-1080.mp4
npm run readme     # docs/assets/readme feature loops + posters
npm run deliver    # docs/demo/muxr-demo.mp4 + muxr-loop.webp
```

- `reel/src/config.ts` — script, timing, palette, and motion tokens
- `reel/src/screens.tsx` — original product-film screens
- `reel/src/AppUI.tsx` — source-faithful ports of shipping mobile surfaces
- `reel/src/ReadmeStories.tsx` — README compositions around those surfaces
- `reel/public/generated/workspace.webp` — Codex GPT Image 2 background; product UI remains source-rendered
- `reel/render.mjs` — renders the 1080p60 master
- `reel/readme.mjs` — renders focused Remotion compositions for the README feature wall
- `reel/deliver.mjs` — publishes the master and README loop

`raw/` is ignored. Only the final assets in `docs/demo/` are committed.
