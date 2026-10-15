# Read whole words at large text

Drive the real unpaired app; no relay or Herdr is needed for the pair
screens. The shared `WordWrappingText` keeps the pair title, comparison words,
the pair card's field label and hint intact by measuring words with the same
font and fitting the whole block to its widest word. Button labels (Connect)
are plain Text, not WordWrappingText; they are fitted only by the pair
screen's narrow mode, which tightens the Connect bar padding under ~200
text-scaled dp (208 dp at font 2.0). The new agent screen's worktree hint
(`Use a separate worktree` / `A fresh checkout on its own branch, so this
folder stays untouched.`) is plain Text: at a narrow width its row stacks so
the copy keeps the full width and stays whole, instead of sharing the row with
its switch and breaking words.

Unlike the pair screens, `/new-agent` draws that hint only when this browser
holds a control grant for the connected machine: `deviceAuthority()` in
`pairing/infrastructure/pairingPlatform.ts` answers `observe` on web without
one, and the screen then shows only "This browser has view-only access…". That
one cell needs the lab browser paired to a running development host through
`lab-browser-pairing.md`, its link grant stored by
`pairing/infrastructure/webSecureStore.ts`; the pair-screen cells stay
unpaired.

1. Capture the original and candidate installed PWA exports with the Visual
   check recipe in `../SKILL.md`: `/` (the link-first connect shell), `/pair`
   and `/new-agent` (scroll the worktree hint at the bottom of the form into
   view, and capture the end of the form).
   Widths 393x864, 270x594 and 208x458 dp, font 1.0 and 2.0, both themes.
   At font 2.0 the CSS viewport is half those dimensions. Capture at rest
   and at the end of each scrollable surface.
2. On a task-owned Android release APK, drive the same unpaired screens at
   270 dp, font 2.0, light and dark. Capture initial and scrolled states
   through `visualCheck.mjs <serial> <dir> <name> [--end]`.
3. PWA: run `visualCheck.mjs pwa-check <shot>.png <name>` on the same page
   immediately after every shot. `word split across lines: "Securely"`,
   `"Connect"`, `"Pairing"` and `"computer"` identify the reported regressions on
   the pair screens; `"worktree"` and `"untouched"` on `/new-agent`. Their
   candidate words must remain on one line; multi-word titles can wrap
   between words. A `clean` lead on `/new-agent` is accepted only after reading
   the hint itself on the page (`Use a separate worktree` and `untouched.`); a
   view-only page draws none of it, so a `clean` there proves nothing. Review
   every screenshot too, especially small text.
4. Native requires Tesseract on PATH in addition to ImageMagick. The checker
   reconciles successive screenshot OCR fragments with the full accessibility
   label; it does not infer line breaks from a TextView's height. An OCR miss
   or misread can hide a split, so a clean lead is not eye-review proof.
5. Run the existing `selftest` and `pwa-selftest` flows: both include split
   Securely/Tailscale/Connect and intact whole-word wrapping. Remove the
   word-split lead in a task-owned scratch copy and verify each flow goes
   red; do not weaken the assertions or commit that scratch copy.

Do not press Connect or approve pairing on the owner's machine for this
read-only typography proof. Preserve source/build identity and the complete
lead logs. Pre-existing layout defects remain listed, never silently ignored.
