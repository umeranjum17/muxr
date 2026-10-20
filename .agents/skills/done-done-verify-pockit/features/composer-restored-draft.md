# Show a restored long draft whole in the agent's prompt field

A draft the app puts back into an agent's prompt field — the one kept when a
person leaves the agent, or a first prompt returned after it failed to send —
shows the way the same text typed by hand does: the field grows to its
normal maximum (six lines at 15 pt) and scrolls inside. Before the fix, the
installed PWA kept the field one row tall, so a restored 12-line draft showed
its first line with the top of the second cut at the field's bottom edge.
Native Android already grew to the restored text; the fix is web only.

## Sub-features

- `restored-grows` web: a 12-line draft restored on reopening the agent fills
  the field to its maximum with whole lines (textarea `clientHeight` 104,
  `scrollHeight` above it), the rest scrolls inside.
- `typed-grows` web: the same 12 lines typed (Shift+Enter between lines) grow
  the field the same way; no sliver of a next line shows at either edge.
- `empty-one-row` web: an empty field stays one row (`clientHeight` 17), its
  placeholder unwrapped, whatever the rail width.
- `native-unchanged` native Android: typed and restored drafts look the same
  on main and on the candidate.

## How to get to it (user POV)

Open an agent, type a long prompt, go back to Home, open the agent again: the
draft is back in the prompt field.

## Driving it with the private stack

Drafts live in memory, so a reload or an app relaunch drops them: type the
draft after each reload or relaunch, then leave and reopen the agent.

PWA:

1. Export with the lab flag and start `browserPairLab.mjs`, serve the export
   and pair the standalone `--app=` window as in `lab-browser-pairing.md`.
2. Open `Pi 1`, focus the prompt field
   (`textarea[aria-label=Prompt]`), and type `Umer long draft line 1` …
   `12` with `chrome-devtools-axi type`, `press Shift+Enter` between lines
   (Enter sends).
3. Per cell (`../SKILL.md` Visual check widths and fonts): `emulate` the
   viewport, `history.back()`, click `Open Pi 1`, then read
   `({n: value.split('\n').length, clientHeight, scrollHeight, scrollTop})`
   from the textarea, `screenshot` as `agent-restored-draft-<w>-<f>-<theme>`
   and run `visualCheck.mjs pwa-check` on it.

Native:

1. Release APK on an owned emulator, paired to `perf/lib/fakeStack.mjs` with
   one agent through the app's `muxr://pair#<code>` link (as `spacesLab.mjs`).
2. Per cell: set size, density, font scale and night mode, force-stop and
   relaunch, open `Pi 1`, tap `Prompt`, type a ~350-character sentence with
   `adb shell input text` in 30-character chunks (spaces as `%s`, never split
   across a chunk), press Back to close the keyboard and capture
   `agent-typed-draft-…` with `visualCheck.mjs`; Back to Home, open `Pi 1`
   again and capture `agent-restored-draft-…`.

Look at the composer in every shot: whole lines, nothing cut at the field's
top or bottom edge, the rail's controls on its last line.

## Gotchas

- `visualCheck.mjs pwa-check` does not flag text cut by a textarea's own box,
  so the main shots of this defect read `clean` for the field. The textarea
  measure and the eye are the proof.
- At 270 dp with font 2.0 (Home lists `Pi 1` below the fold) tap the Live
  row `Pi 1. …` instead of `Open Pi 1`.
- At PWA font 2.0 the field has the rail's first line to itself
  (`agent-narrow-chrome.md`), so the draft wraps whole words there.
