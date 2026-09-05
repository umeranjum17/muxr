# Panes

Terminal-driven tools in muxr, and every pane that has no agent.

## What appears in muxr

- **Tools** — a chip in the session header. Sections, in order:
  1. **Running** — agentless panes already open
  2. **Terminal apps** — nvim, lazygit, yazi, btop, Shell, and other programs on this machine
  3. **Plugin tools** — panes declared by enabled Herdr plugins
  4. **Plugin commands** — global actions only for plugins that declare no pane
- **Panes** — a top-level destination listing every Herdr pane with no agent. Tap one to open its live terminal.

A plugin that declares any pane has that pane as its only Tools launch row. Plugins with no pane keep their global commands. Row titles come from the pane or action contribution, never from a plugin id. A missing plugin name is shown as **Extension**.

## What runs on the host

`panes.mjs`, called by muxr as a read RPC (`list`, `tools`) or a write RPC
(`launch`). It shells out to `herdr` — `pane list`, `workspace list`,
`plugin list`, `tab create`, `pane rename`, `pane run`, `plugin pane open`,
`plugin action invoke` — and returns bounded JSON. No daemon, no state file.

## How a tool reaches your phone

muxr already routes a pane with no agent as `shell:<paneId>`, so an ANSI TUI
needs no new transport. Graphics panes use muxr's generic Herdr-to-Kitty
bridge; this plugin contains no graphics or producer-specific code. `launch`
opens ordinary tools in their own tab, while a third-party action controls its
own placement. The resulting agent-less pane is then opened through the same
`kernel.navigate` route.

The name on the pane is the only state this plugin keeps, and it is visible in
Herdr rather than hidden in a private index.

For graphics tools, attach a muxr terminal before launching the producer so the
process-wide graphics client is registered. The normal phone flow does this:
open **Tools**, launch the action, then tap its new **Running** row (or open it
from **Panes**).

### What a graphics producer owes the phone

Any Kitty producer works the same way: it repaints, muxr forwards. Two things
about it decide how the pane feels, and neither is specific to one program.

- **A repaint is a frame, and a frame crosses a socket that sustains about
  3 MB/s.** muxr forwards only the newest frame of a surface, and releases the
  rest of a scroll gesture one wheel notch per delivered frame, so a fling
  travels as fast as the producer can actually answer. A producer that offers a
  frame-rate cap should use one — `TERMINAL_BROWSER_FPS=10` for the terminal
  browser, and its `TERMINAL_BROWSER_MAX_PIXELS` for the pixel budget — because
  paints it never makes cost nothing at all.
- **Placement is provenance.** An image covering its pane is the pane's whole
  surface: the phone takes over scrolling and pointer input for it. A smaller
  image — `icat` above a prompt, a plot beside its legend — keeps the cell and
  cell span Herdr gave it, several of them live at once, and the pane keeps its
  own gestures. Deleting one (`a=d,d=I,i=<id>`) removes exactly that image,
  because the ids the phone holds are Herdr's own.

## Permissions and data

No secrets, no config, nothing written to `MUXR_PLUGIN_STATE_DIR`. It can start
processes on your computer, which is what launching a tool means. A launched
program inherits the calling session's working directory.

## Known limits

- **Launching is two taps the first time.** A plugin RPC result cannot carry a
  navigation, so the first tap launches and the second opens it. Once a tool is
  running it is one tap.
- **Plugin actions place their own pane.** Herdr resolves an action against the
  pane focused at the desk, not the session you are looking at on the phone.
  Plugin *panes* are unaffected — this plugin places those itself.
- **Graphics producers should start after muxr attaches.** A producer that
  emitted its initial frame before muxr's process-wide graphics client registered
  may not retry. If a later-opened pane is blank, restart the producer while the
  muxr terminal is attached.
- **Reading is visual, not DOM extraction.** muxr renders pixels and accepts
  touch/pointer, IME, and key-bar input. Herdr scrollback does not expose DOM
  text, selectors, or accessibility nodes.

## Offline

Rows come from a host RPC, so an offline phone shows the last snapshot marked
stale and cannot launch.

## Disable

Per phone in **Settings → Plugins**, or on the computer:

```bash
herdr plugin disable muxr.panes
```

## Versions

muxr UI 8+, Herdr 0.8.0+, linux and macOS.
