# Site app icon

`muxr-app-icon.png` is imported from `apps/mobile/sources/assets/images/icon.png`
in the public muxr repository at the commit recorded in
[`marketing.lock.json`](../../marketing.lock.json).
The app's `scripts/genBrand.sh` creates this raster artwork; there is no vector
app-icon source. The SVG favicon embeds that artwork without tracing or changing
its glyph, colours or padding.

Use the [marketing sync workflow](../../README.md#product-marketing-source-of-truth)
to import the canonical icon and regenerate the 16/32px PNGs,
16/32/48px ICO, SVG and opaque 180px apple-touch icon. Every site page references
these assets. [`scripts/generate-site-icons.mjs`](../../scripts/generate-site-icons.mjs)
owns derivative generation.
Root favicon and apple-touch URLs also support automatic discovery.
The site has no PWA manifest.
