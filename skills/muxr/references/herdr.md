# Herdr orchestration

Herdr owns muxr's terminal workspaces, panes, agents, and worktrees. Its CLI
updates independently from muxr, so the installed binary is the only command
contract: read the **Installed Herdr CLI reference** below before driving Herdr.
If that section is missing, run `herdr --skill` and follow its output.

## muxr conventions

- Prefer a Herdr pane over an in-process subagent when work should stay running,
  run in parallel, or remain visible on the user's phone.
- Every Herdr pane exports `HERDR_PANE_ID` (for example `w2A:p4`). Never guess
  ids. The current workspace is `${HERDR_PANE_ID%%:*}`.
- Keep `HERDR_PANE_ID` private. User-facing messages use workspace, tab, pane,
  machine names, Human Names, and Task Titles rather than internal ids.
- Final user-facing files belong in
  `$HOME/.muxr/attachments/pane/$HERDR_PANE_ID`; quote the path because the pane
  id contains a colon. Skip attachment publication when the variable is unset.
- Use persistent, phone-visible Herdr work for long builds and servers rather
  than blocking the current agent session.

## Packaged-reference behavior

This source page intentionally contains no vendored Herdr command list.
`muxr --skill` appends the installed binary's `herdr --skill` output at command
time. Setup, integration sync, and update never install skills or change agent
prompt files.
