# Feature gallery

Every screenshot below was captured live against the deployed stack (herdr server
+ relay + host as systemd units, the web app on a phone).

## The core loop: blocked agent → inbox → approve → done

1. An agent was prompted to run a network command; herdr marked it **blocked**.
2. **Herd** (`01-home-live-cards.png`) — the LIVE card shows the approval dialog
   *inside the terminal thumbnail*.
3. **Inbox** (`02-inbox-kanban-blocked.png`) — NEEDS YOU at the top, DONE below.
4. **Terminal** (`03-terminal-approval-dialog.png`) — the agent's real approval
   UI, key bar beneath with 1/2/3/esc.
5. **Answered from the phone** (`04-approval-answered.png`) — tapped "1" on the
   key bar; the agent ran the command and finished. herdr flipped blocked → done.

The same loop for a question UI: `10-pi-question-dialog.png` shows an agent's
interactive question rendered in the terminal, `12-pi-question-answered.png` the
answer sent from the phone.

## Squads and splits

- `05-new-agent-squad-select.png` — the new-agent screen: pick up to 4 agent
  kinds to run together as a squad.
- `06-squad-running.png` — a squad live: one workspace, one tab per agent.
- `08-grid-split.png` — the grid view rendering a tab's real split layout with
  live terminal tiles.

## Workspaces and worktrees

- `07-spaces.png` — the workspace view: every project, its tabs, its agents.
- `09-worktree-session.png` — an agent started inside a fresh git worktree from
  the phone: isolated checkout for parallel work.
- `11-home-after-cleanup.png` — the Herd screen steady-state: live cards for
  what's working, workspace cards for where it lives.
