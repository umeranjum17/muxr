# Panes

Terminal-driven tools in muxr, and every pane that has no agent.

## What appears in muxr

- **Tools** — a chip in the session header. Editors and TUIs found on this machine
  (nvim, lazygit, btop, …), the panes and actions declared by your enabled Herdr
  plugins (terminal-browser, herdr-file-viewer, muxr setup/pair/doctor …), and a
  plain shell. Anything already open is listed first and opens in one tap.
- **Panes** — a top-level destination listing every Herdr pane with no agent:
  plugin panes, TUIs, shells. Tap one to open its live terminal.

## What runs on the host

`panes.mjs`, called by muxr as a read RPC (`list`, `tools`) or a write RPC
(`launch`). It shells out to `herdr` — `pane list`, `workspace list`,
`plugin list`, `tab create`, `pane rename`, `pane run`, `plugin pane open`,
`plugin action invoke` — and returns bounded JSON. No daemon, no state file.

## How a tool reaches your phone

muxr already routes a pane with no agent as `shell:<paneId>`, so an ANSI TUI
needs no new transport. On Android, graphics panes use muxr's generic
Herdr-to-Kitty bridge and libghostty renderer; the Panes plugin contains no graphics or
terminal-browser-specific code. `launch` opens ordinary tools in their own tab,
while a third-party action such as terminal-browser controls its own placement.
The resulting agent-less pane is then discovered and opened through the same
`kernel.navigate` route.

The name on the pane is the only state this plugin keeps, and it is visible in
Herdr rather than hidden in a private index. An agent can discover and invoke an
enabled global third-party action directly with:

```bash
herdr plugin list --json
herdr plugin action invoke open-split --plugin zenbu-labs.terminal-browser
```

For graphics tools, attach/open a muxr terminal before launching the producer so
the process-wide graphics client is registered. The normal phone flow does this
naturally: open **Tools**, launch the action, then tap its new **Running** row (or
open it from **Panes**).

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
- **Graphics producers should start after muxr attaches.** A producer that emitted
  its initial frame before muxr's process-wide graphics client registered may not
  retry. If a later-opened pane is blank, restart the producer/action while the
  muxr terminal is attached.
- **Reading is visual, not DOM extraction.** muxr renders the browser pixels and
  accepts touch/pointer, IME, and key-bar input. Herdr scrollback and terminal
  observers do not expose browser DOM text, selectors, or accessibility nodes.
- **Click behavior is terminal-mode dependent.** A real graphics frame enables
  pane-scoped pointer mode. Ordinary text terminals retain their existing
  selection/scroll behavior; keyboard-first TUIs remain the safest text tools.

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
