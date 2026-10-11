# Watch from a view-only browser that cannot type

A browser paired with `muxr pair --browser-view` holds a `view` link grant. The
host's link gate drops everything it sends except reads: terminal input,
`desktop.open`, and agent actions (`session.prompt`, `session.stop`, …). The
client sends no terminal input from a view grant, so no faint predicted echo
appears either. A `--browser` (control) PWA on the same host still types.

## Sub-features

- `consent` the pair screen says "This browser can watch <computer>, but can't
  type, click or run anything."
- `banner` the terminal shows "View-only browser · can watch, but can’t type,
  click or run anything".
- `settings` Connection says "This browser can watch your computer, but can't
  type, click or run anything."
- `terminal` typing a command and Enter in a pane changes nothing on the
  computer; the host logs one `link: dropped terminal input from view-only
  device <id>` line per device and input kind for the host's lifetime, never
  the payload.
- `watch` output the control browser causes appears in the view browser.
- `control` the control PWA's command runs.

## Driving it

Typing must reach a real shell, so use the real Herdr lab
(`scripts/diagnostics/application/linkHerdrLab.mjs` through
`HERDR_LAB_HELPER`), not the fake stack: its terminal never runs input.

1. Start the lab, then `session.start {kind:'shell', cwd:<marks dir>}` over its
   control link so there is a pane.
2. Mint a view link and a control link over the host's `pair.sock` with intent
   `{kind:'browser', authority:'observe'|'control', personal:false}`.
3. Serve the export (`serveWebExport.mjs`), open each role in its own
   installed-PWA profile, and pair through the pair screen by opening
   `/pair?offer=<encoded https://lab.invalid/pair#byokit-link:…>`; read the
   consent before tapping Pair.
4. In the view PWA open the shell, type `touch <marks>/view-typed`, Enter: no
   file, no echo. In the control PWA type `touch <marks>/control-typed`, Enter:
   the file exists and the view PWA shows the output.

The link gate itself is covered by `drops every input a view-only device sends`
in `apps/host/src/machine/infrastructure/linkTerminal.integration.test.ts`.

## Gotchas

- An existing browser record stored without `authority` enrols as view: the
  domain default for browsers. Only an explicit `control` record controls.
- Desktop watching is unavailable to a view grant: `desktop.open` answers
  `permission-denied`, because a desklink 0.5 session always carries an input
  channel.
- On an Android emulator, install the PWA from Chrome's menu (Add to Home
  screen, Install) and reach it over `adb reverse` for both the web and relay
  ports, so `127.0.0.1` stays a secure context. Changing `font_scale` or night
  mode restarts the PWA at its start URL; open `/pair?offer=…` afterwards.
- `adb shell input text` typed straight into the xterm repeats characters
  through Gboard's composition, so bash gets garbage. Send the control check
  through the Prompt composer instead.
