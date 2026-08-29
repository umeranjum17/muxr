# Pane titler

Owns the two user-facing names: Herdr `agent.name` is Agent Name, while the
pane/tab label is Task Title.

## What appears in muxr

The session Actions menu includes a native Agent Name editor backed by bounded
host RPCs. It reads and renames the real Herdr agent; every muxr surface reads
that current Herdr value.

## What runs on the host

On install or update, `backfill.mjs` backfills every existing unnamed/internal
agent with an available deterministic animal through `herdr agent rename`.
After that, `pane.agent_status_changed` preserves every public Herdr Agent Name
and applies the same backfill to new agents. It reads about 60 lines of current
scrollback and recomputes a Task Title only while the current Herdr pane label
still carries generated chrome. A prior process generation is never restored.

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

Diagnostic model outcomes go to `$MUXR_PLUGIN_STATE_DIR/titler.log`. Agent Names
and Task Titles live only in Herdr.

## Offline

No model reachable means no rename. Nothing else changes.

## Disable

`herdr plugin disable muxr.pane-titler`, or unlink it. Existing names stay.

## Requires

Herdr 0.8.0, Node, and `pi` on the machine. Linux and macOS.
