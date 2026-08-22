# muxr demo

The 59-second product film is typeset in Remotion using muxr's real mobile design tokens and components. It does not depend on recorded terminal or phone footage.

```bash
cd tools/demo
npm install
npm run reel       # raw/muxr-demo-1080.mp4
npm run deliver    # docs/demo/muxr-demo.mp4 + muxr-loop.webp
npm run aso        # Play + App Store screenshot sets
```

- `reel/src/config.ts` — script, timing, palette, and motion tokens
- `reel/src/screens.tsx` — desktop and mobile screens
- `reel/render.mjs` — renders the 1080p60 master
- `reel/deliver.mjs` — publishes the master and README loop
- `aso/compose.mjs` — composites clean phone mockups over the Codex-generated campaign background

`raw/`, review stills, and intermediate ASO mockups are ignored. Final film and store assets live in `docs/`.
