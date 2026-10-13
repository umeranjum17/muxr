# Read whole words at large text

Drive the real unpaired app; no relay or Herdr is needed. The shared
`WordWrappingText` keeps the pair title, comparison words, the pair card's
field label and hint, and ActionButton labels intact by measuring words with
the same font and fitting only a word that exceeds the available line. A
single-line button fits the whole label. Under ~200 text-scaled dp (208 dp at
font 2.0) the pair screen tightens its padding so words fit at a readable size
instead of shrinking.

1. Capture the original and candidate installed PWA exports with the Visual
   check recipe in `../SKILL.md`: `/` (the Tailscale step) and `/pair`.
   Widths 393x864, 270x594 and 208x458 dp, font 1.0 and 2.0, both themes.
   At font 2.0 the CSS viewport is half those dimensions. Capture at rest
   and at the end of each scrollable surface.
2. On a task-owned Android release APK, drive the same unpaired screens at
   270 dp, font 2.0, light and dark. Capture initial and scrolled states
   through `visualCheck.mjs <serial> <dir> <name> [--end]`.
3. PWA: run `visualCheck.mjs pwa-check <shot>.png <name>` on the same page
   immediately after every shot. `word split across lines: "Securely"`,
   `"Tailscale"`, `"Connect"`, `"Pairing"` and `"computer"` identify the reported regressions. Their
   candidate words must remain on one line; multi-word titles can wrap
   between words. Review every screenshot too, especially small text.
4. Native requires Tesseract on PATH in addition to ImageMagick. The checker
   reconciles successive screenshot OCR fragments with the full accessibility
   label; it does not infer line breaks from a TextView's height. An OCR miss
   or misread can hide a split, so a clean lead is not eye-review proof.
5. Run the existing `selftest` and `pwa-selftest` flows: both include split
   Securely/Tailscale/Connect and intact whole-word wrapping. Remove the
   word-split lead in a task-owned scratch copy and verify each flow goes
   red; do not weaken the assertions or commit that scratch copy.

Do not press Connect, open Tailscale's store, or approve pairing for this
read-only typography proof. Preserve source/build identity and the complete
lead logs. Pre-existing layout defects remain listed, never silently ignored.
