# Paint the installed PWA landing without the terminal payload

The installed web client paints its landing and pair screens without first
loading the session/terminal/editor/syntax-highlight payload. The session route
lazy-loads `TerminalRoute` (which lazy-loads the xterm `TerminalView`), the
document/diff/CodeCore surfaces load behind one lazy chunk
(`components/code/codeSurfaces.tsx`), and the diff viewer resolves `shiki` to the
slim static bundle (`components/diff/shikiSlim.ts`) with both `@pierre/diffs`
entry points behind one boundary (`components/diff/pierreBundle.ts`). Those
chunks are requested only when a screen that draws a terminal, code or a diff
opens.

## Sub-features

- The initial transfer (`dist/index.html`'s referenced JS/CSS) sits in the eager
  entry + `__common` chunk. `scripts/diagnostics/application/checkWebExport.mjs`
  measures it as gzip and enforces the ratchet; the eager `__common` no longer
  carries xterm, the diff surfaces or the shiki grammars.
- `grep -c 'xterm'`/`'shiki'`/`'Oniguruma'`/`'PierreDiffView'` against the eager
  entry and `__common` chunks is `0`; they appear only in the lazy
  `TerminalRoute-*.js` (which holds the xterm `TerminalView` boundary),
  `codeSurfaces-*.js` and `pierreBundle-*.js` chunks.
- The 30-grammar slim set loads with the lazy diff chunk. Every other shiki
  grammar (Vue, C#, Svelte, Lua, Dart, Elixir, Scala, Zig, ...) is fetched on
  demand as one JSON file per language from `/shiki-langs/`, built by
  `apps/mobile/scripts/buildShikiLangs.mjs`. A diff renders plain text until the
  grammar resolves, then re-renders highlighted. A TypeScript-only diff fetches
  no grammar asset at all.
- Opening a session route still loads `TerminalRoute-*.js` and renders the
  not-paired/session state — never a blank screen.

## How to get to it (user POV)

Install the web client (or open the export in a standalone window) and
cold-start it on a phone network. The landing paints, then the pair screen. Open
an agent: the terminal appears (its chunk arrives then), and opening a file or
change shows the highlighted surface. Nothing terminal/editor/highlighter
related is transferred before the landing paints. A change to a language outside
the slim set shows its grammar fetched from `/shiki-langs/<id>.json` when the
diff opens, and highlights once it lands.

## Driving it with the private stack

Preconditions: build the export (`yarn build && yarn web:export:selfhost`). No
host, relay or Herdr is needed for the transfer proof; a paired host is only
needed to render the diff surface.

1. Serve the built dist with the repo static server on a free port (not 8792):
   `MUXR_WEB_EXPORT_DIR=<repo>/apps/mobile/dist MUXR_WEB_PORT=<free> node scripts/diagnostics/application/serveWebExport.mjs`.
   It serves files verbatim (no gzip), so browser transfer is raw.
2. Initial transfer, offline: `node scripts/diagnostics/application/checkWebExport.mjs`
   prints `dist usable gzip ratchet … — <n> bytes` and `dist __common chunk
   ratchet — <n> bytes`; both must pass, plus `dist ships on-demand grammar
   assets` and `dist initial payload never references a grammar asset`.
3. Chunk split: list `dist/_expo/static/js/web`, and confirm the eager entry
   (`index-*.js` referenced by `dist/index.html`) and `__common-*.js` contain no
   `xterm`/`shiki`/`Oniguruma`/`PierreDiffView`, while lazy `TerminalRoute-*.js`
   (it holds the xterm `TerminalView` boundary; no separate `TerminalView-*.js`
   chunk is emitted), `codeSurfaces-*.js`, `pierreBundle-*.js` exist.
4. Cold browser load: one origin per capture (or a fresh profile) for an empty
   cache, `chrome-devtools-axi emulate --network "Slow 4G"` (plus
   `--viewport 393x852x3,mobile,touch` and `--color-scheme dark|light`), open the
   URL, wait until the landing text mounts, then read
   `performance.getEntriesByType("resource")` (sum `transferSize`) and
   `first-contentful-paint`/`navigation.loadEventEnd`. For a true standalone
   window launch Chromium with `--app=<url>` and assert
   `matchMedia('(display-mode: standalone)').matches === true`.
5. Route chunks: open `/session/<any-id>` and assert the `TerminalRoute-*.js`
   request happened and the screen shows the not-paired state, not a blank body.
6. Diff surface: with a paired host, open a commit/change and assert the
   `codeSurfaces-*.js` and `pierreBundle-*.js` requests happened and the diff
   renders highlighted.
7. On-demand grammars, without a host: bundle the diff surface's `shiki` alias
   and `@pierre/diffs/react` for the browser with the repo's `esbuild`
   (`--alias shiki` -> `sources/components/diff/shikiSlim.ts`, mirroring the
   Metro alias), serve the harness from `dist` so `/shiki-langs/` resolves, and
   render a patch whose files are `App.vue` and `greet.ts`. Confirm from the
   browser network log that `/shiki-langs/index.json` and
   `/shiki-langs/vue.json` are fetched and the diff paints Vue and TypeScript
   highlighting at 393 px light and dark; render a TypeScript-only patch and
   confirm no `/shiki-langs/` request happens.

## Gotchas

- A warm `__common`/entry in the same profile makes the transfer look tiny; use
  a distinct origin (port) or a fresh profile for every cold measurement.
- `serveWebExport.mjs` does not gzip, so browser byte totals are ~4x the
  `checkWebExport` gzip budget; compare before/after raw, and quote the gzip
  budget from the check, not the browser.
- The commit / changes-file routes need a paired host to render; without one
  they show the transport error and never fetch `codeSurfaces`. When no host is
  available, drive the diff surface standalone with step 7 instead of claiming
  the app route rendered.
- The on-demand grammar assets live in `dist/shiki-langs/` (built into
  `public/shiki-langs/` before the export; gitignored like canvaskit). A stale
  `public/shiki-langs/` after a `@shikijs/langs` bump re-serves old grammars:
  re-run `npm run setup-shiki-langs` (it always regenerates).
- `--app=` is the only way to get `display-mode: standalone`; a DevTools
  viewport emulation does not set it.
