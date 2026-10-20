# Keep every New agent field clear of the sticky Start button

On the New agent screen the Start button is a sticky footer outside the scroll
view. The scroll content must end above it (bottom padding equal to the
footer's height plus a gap, the MissingFileState footer/inset pattern), so at
max scroll every field — the Folder field above all — rests fully visible
above Start and a tap meant for a field can never hit Start. When the content
padding was smaller than the footer (32px vs ~80px+, more at large font), the
form's bottom stayed clipped under the opaque footer at 270 dp and a tap near
the Folder field started an agent in `~` instead.

## How to get to it (user POV)

- Home → New agent (or deep link `muxr://new-agent`) → pick an agent card →
  scroll to the very bottom.

## Driving it with the private stack

- Native release APK on a task-owned emulator (the PWA shares the component;
  capture there only if its layout diverges).
- Per the `../SKILL.md` Visual check matrix, at minimum the extreme cell:
  270 dp (`wm size 1080x2376; wm density 640`), font 2.0, light and dark,
  scrolled to the end (`visualCheck.mjs --end`).
- Expected: at max scroll the worktree row and its subtitle sit fully above
  the footer with visible clearance; scrolling up shows the Folder field
  (`Browse folders`) fully above Start. Any text or control cut by the footer
  is a FAIL — that is the regression this guards.

## Evidence

`data/rd-newagent-folder-under-start/evidence/visual/native/` — before
(`main/`) cells showing the worktree subtitle clipped under the Start footer
at 270 dp font 2.0 light+dark, and after (`candidate/`) cells at 270 dp font
2.0 light+dark and 393 dp font 1.0 light+dark with the Folder field and all
content clear of Start.
