# muxr demo

The 59-second product film is typeset in Remotion using muxr's mobile design tokens and component recipes. It does not depend on recorded terminal or phone footage.

```bash
cd tools/demo
npm install
npm run reel       # raw/muxr-demo-1080.mp4
npm run readme     # docs/assets/readme feature loops + posters
npm run deliver    # docs/demo/muxr-demo.mp4 + muxr-loop.webp
```

- `reel/src/config.ts` — script, timing, palette, and motion tokens
- `reel/src/screens.tsx` — desktop and mobile screens
- `reel/render.mjs` — renders the 1080p60 master
- `reel/readme.mjs` — renders focused Remotion compositions for the README feature wall
- `reel/deliver.mjs` — publishes the master and README loop

`raw/` is ignored. Only the final assets in `docs/demo/` are committed.
