# Pane titler

Owns two Herdr fields and nothing else.

- **Agent Name** is Herdr `AgentInfo.name`. Only a missing or internal name
  (`pp_` / `pph_`) gets one unused deterministic animal through
  `herdr agent rename`. Every public name is left alone.
  `display_agent` is never identity and is never written.
- **Task Title** is Herdr `AgentInfo.title`. When that title is missing,
  generated chrome, or semantically equal to `name`, this plugin prefers the
  provider's own terminal title, then a bounded 2–4 word title from the
  current generation's output, and writes it with
  `herdr pane report-metadata` (`--source muxr.pane-titler.v3`,
  `--agent` = current Agent Kind, `--seq` when Herdr exposes
  `state_change_seq` or `revision`, `--title` only). A missing
  `agent_session` no longer skips the write; the current pane generation is
  fenced with session identity when present, otherwise revision/seq.
  It never uses `pane rename` or `tab rename`.
- Provider `agent` and optional `display_agent` stay untouched.

## What appears in muxr

The session Actions menu includes a native Agent Name editor backed by bounded
host RPCs. It reads and renames the real Herdr agent; every muxr surface reads
that current Herdr value. Task Title is the live Herdr `title`.

## What runs on the host

On install or update, `backfill.mjs` backfills every existing unnamed/internal
agent with an available deterministic animal through `herdr agent rename`.
After that, `pane.agent_status_changed` preserves every public Herdr Agent Name
and applies the same backfill to new agents. It reads current `AgentInfo`,
about 60 lines of current scrollback, and recomputes a Task Title only while
`title` is missing, generated chrome, or equal to `name`. Immediately before
`report-metadata` it re-reads the agent; a replaced generation does not
receive the previous output's title. Herdr's `--agent` guard keeps the title
visible after lifecycle authority becomes idle while rejecting a different
Agent Kind.

## Which model

The hook reads the live Herdr `agent` kind and uses that provider's own command
path. Claude and Codex use the packaged minimal ACP bridge to invoke their
installed provider CLI with bounded low-cost, no-tool/read-only settings.
Cursor uses its native ACP server with Auto, OpenCode uses its native ACP server
with a low-cost model selected through the ACP session configuration, and Pi
sessions call Pi directly. No provider is bridged through Pi. Each attempt is
bounded to 12 seconds.
Unsupported kinds, missing credentials, and unavailable providers fall through
to the bounded current-output title, so title generation never depends on a
model. The plugin always writes Herdr metadata; it never renames pane or tab
navigation.

## Where it stores data

Diagnostic model outcomes go to `$MUXR_PLUGIN_STATE_DIR/titler.log`. Agent Names
and Task Titles live only in Herdr. This plugin does not persist titles itself.

## Offline

No model is required for Agent Name backfill or the deterministic current-output
Task Title fallback.

## Disable

`herdr plugin disable muxr.pane-titler`, or unlink it. Existing names stay.

## Requires

Herdr 0.8.0 and Node on Linux or macOS. The detected provider CLI is optional;
when unavailable, the deterministic fallback still supplies a Task Title.
