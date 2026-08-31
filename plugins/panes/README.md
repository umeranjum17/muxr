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

muxr already routes a pane with no agent as `shell:<paneId>`, so a TUI needs no
new transport. `launch` opens the tool in its own tab (a phone wants the whole
viewport, not a split) and names the pane after the tool; the row's
`kernel.navigate` action then opens that pane's existing live terminal.

The name on the pane is the only state this plugin keeps, and it is visible in
Herdr rather than hidden in a private index.

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
- **Mouse-driven TUIs are only partly usable.** Keys and scroll work; there is no
  tap-to-position, because neither the terminal view nor Herdr's attach protocol
  carries a mouse click. Keyboard-first tools are fine.

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
