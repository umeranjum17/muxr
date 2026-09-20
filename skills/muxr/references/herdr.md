# Herdr orchestration

Herdr owns muxr's terminal workspaces, panes, agents, and worktrees. Its CLI
updates independently from muxr, so the installed binary is the only command
contract: read the **Installed Herdr CLI reference** below before driving Herdr.
If that section is missing, run `herdr --skill` and follow its output.

## muxr conventions

- Prefer a Herdr pane over an in-process subagent when work should stay running,
  run in parallel, or remain visible on the user's phone.
- Every Herdr pane exports `HERDR_PANE_ID`. Never guess ids. The current
  workspace is `${HERDR_PANE_ID%%:*}`.
- Keep `HERDR_PANE_ID` private. User-facing messages use workspace, tab, pane,
  machine names, Agent Names, and Task Titles rather than internal ids.
- Final user-facing files go through `muxr share <path>` into the pane's durable
  Shared Artifacts history; the muxr skill's Shared Artifacts section owns that
  convention. Direct copies land in
  `$HOME/.muxr/attachments/pane/$HERDR_PANE_ID` (quote the path: the pane id
  contains a colon). Skip publication when the variable is unset.
- Use persistent, phone-visible Herdr work for long builds and servers rather
  than blocking the current agent session.
- Name your own workspace and pane at task start — use the canonical
  `muxr name --workspace LABEL --pane TITLE --provider PROVIDER --model MODEL`
  facade from the muxr skill. It binds to the current Herdr pane.

## Packaged-reference behavior

This source page intentionally contains no vendored Herdr command list.
`muxr --skill` appends the installed binary's `herdr --skill` output at command
time. Setup, integration sync, and update never install skills or change agent
prompt files.
