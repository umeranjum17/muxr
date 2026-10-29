# A link an agent wrapped over several rows opens whole

An agent that wraps its own text (Claude Code) ends each row with a real new
line at the column width, so a long URL such as an npm link shows up as rows
of the same width with no soft-wrap flag between them. Tapping the last row
used to hand the browser only that row's piece, and the first rows opened a
cut link. The tap now joins the rows into one link and offers that link whole,
and the underline covers every row of it.

## Sub-features

- `wrapped-join` a row filled to the exact column width, a real new line, and
  a next row that starts with URL characters and keeps the whole a valid web
  URL read as one link, over two or more rows.
- `wrapped-break` a full-width URL row followed by text that cannot continue it
  (a bad port, a blank-led line) is a genuine line break: nothing joins.
- `wrapped-open` the link menu's Open sends the whole joined address to the
  browser, the same text Copy puts on the clipboard.

The web terminal decides in `joinedTerminalWindow`
(`apps/mobile/sources/terminal/domain/safeTerminalLink.ts`); the Android grid
carries the same rule in `GhosttyTerminalView.kt` (`patches/expo-libghostty+0.8.1.patch`,
`hardWrapKeepsUrl`). The flow test is
`apps/mobile/sources/terminal/domain/safeTerminalLink.spec.ts`. iOS finds its
links in Ghostty itself and keeps its soft-wrap-only join.

## How to get to it (user POV)

- Home -> an agent whose reply holds a long link -> tap any row of the link ->
  Open.

## Driving it with the private stack

Preconditions: `yarn build`, a lab dev-id release APK of this tree
(`PHONE_APK`, package `app.muxr.links1.dev`) and the test phone under its
keeper lock.

1. `mkdir -p "$EVIDENCE"`, then
   `PHONE_SERIAL=<serial> PHONE_APK=<apk> ~/firstmate/config/fm-device-lock.sh <serial> node .agents/skills/done-done-verify-pockit/features/terminalWrappedLinkLab.mjs "$EVIDENCE"`.
   The journey starts the fake stack, drops one long npm URL in the fake
   Herdr's `<socket>.print-url` (the fake then paints it with a real new line
   every `cols` characters), pairs the lab app, opens the shell pane, taps the
   last row of the link and chooses Open.
2. Pass: `chrome-tabs.json` holds a tab on the whole URL, `shot-1-wrapped-url.png`
   shows it over four or more rows, `shot-2-link-menu.png` the link menu and
   `shot-3-destination.png` the page that opened.
