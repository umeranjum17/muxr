# Pane titler

Names each pane after the work happening inside it, so a herd of agents is
referrable by thumb and by voice instead of being "pi 3" or an animal.

## What appears in muxr

Nothing directly. This is a Herdr plugin with no `muxr-ui.json`; muxr shows it
as "Backend only". The names it writes flow to the phone because muxr renders
the herd tree Herdr reports.

## What runs on the host

One command on `pane.agent_status_changed`: read about 60 lines of scrollback,
ask a model for a short title, `herdr pane rename`. It renames only panes that
still carry a generated name (herd animals, bare numbers, agent kinds), so an
explicit name you chose is never overwritten.

## Which model

The cheapest first, falling through to the next whenever a subscription is rate
limited or unavailable:

1. `opencode-go/deepseek-v4-flash`
2. `opencode-go/glm-5.1`
3. `opencode-go/mimo-v2.5`
4. `kimi-coding/k3-256k`

If every one is unavailable the pane keeps its current name and nothing is
logged to the user.

## Where it stores data

`$MUXR_PLUGIN_STATE_DIR`, falling back to `~/.muxr/plugin-state/muxr.pane-titler`:
`named.json` (panes it has titled) and `titler.log` (which model answered).

## Offline

No model reachable means no rename. Nothing else changes.

## Disable

`herdr plugin disable muxr.pane-titler`, or unlink it. Existing names stay.

## Requires

Herdr 0.8.0, Node, and `pi` on the machine. Linux and macOS.
