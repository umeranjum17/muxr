# Follow a Herdr agent's status live

The host mirrors every Herdr workspace, pane and agent status the phone shows.
It rides the Herdr kit's own event socket and per-agent status watches, so an
agent going working → blocked → idle reaches Home and the agent screen without
the host opening sockets of its own.

## Sub-features

- A new workspace or pane appears in the host's tree without a restart.
- An agent's status changes (working, blocked, idle) land within a second.
- The host holds one Herdr socket with no agents, plus exactly one per agent
  (the kit's status watch), and drops it when the pane closes.
- Applying a saved layout starts each recorded agent through the kit's
  `startAgent`, and that agent comes up in the new tab.
- Closing an agent climbs pane → tab → workspace → worktree group on the kit's
  `closePane`/`closeTab`/`closeWorkspace` refusals, asking before each wider
  close; the group ask names the repo and member count from the kit's refusal,
  and a confirmed group close is the kit's confirmed `closeWorkspace`.
- Starting an agent goes through the kit's `startAgent` label place: a folder
  with no workspace gets one workspace whose only tab carries the task title,
  a second start reuses it in a new labelled tab, a plan account's values reach
  the agent process through the kit's verifying overlay, and a start that
  cannot launch leaves no workspace behind.

## How to get to it (user POV)

Run agents in Herdr with the host running; Home and the agent screen show each
agent's status as it changes.

## Driving it with the private stack

Preconditions: a built host (`yarn build`) and the guarded lab helper
`fm-herdr-lab.sh` (name, provision, run, teardown); no relay or phone needed.

1. Install one EXIT trap that tears the lab down, then `provision` a named lab
   session and read its `socket_path` from `run <session> session list --json`.
2. `node .agents/skills/verify-pockit/features/herdrStatusLab.mjs <socket> <scratch>`
   in the background; keep its PID and log.
3. `run <session> workspace create --label kit-lab`, then
   `run <session> pane report-agent --source lab --agent pi --state working --seq 1 w1:p1`,
   then `blocked` (`--seq 2`) and `idle` (`--seq 3`), then `pane close w1:p1`.
4. After each step count the probe's sockets: `ss -xp | grep "pid=<PID>," | wc -l`.
   Expect 1, 2 with the agent, 1 after close. The log shows
   `kit-lab/w1:p1:pi:working` → `blocked` → `idle` → gone.
5. Layout: `mkdir <scratch>/cwd`, then
   `node .agents/skills/verify-pockit/features/herdrLayoutLab.mjs <socket> <scratch>/layout <scratch>/cwd`.
   It applies a split whose first pane records `pi` and must print
   `PASS layoutApply started pi via the kit` (a real pi; the lab helper gives it a
   disposable home).
6. Close ladder: `node .agents/skills/verify-pockit/features/herdrCloseLab.mjs <socket> <scratch>/close`
   (shells only; it makes its own git repo and linked worktree). It must print a
   `PASS` line for the split pane, the tab ask and close, the workspace ask and
   close, and the group ask ("Closing repo will close 2 workspaces in this
   worktree group.") and close, then `PASS herdrCloseLab`.
7. Starts: `node .agents/skills/verify-pockit/features/herdrStartLab.mjs <socket> <scratch>/start`
   (a real `pi`, no sign-in). It must print a `PASS` line for the one labelled
   tab, the overlay in the agent process (read from `/proc/<pid>/environ`), the
   reused workspace, the labelled shell, the shell abort and the failed start
   that leaves no workspace, then `PASS herdrStartLab`.
8. SIGTERM the status probe (it disposes the source), then teardown; teardown
   must exit 0.

## Gotchas

`report-agent` fakes the lifecycle, so no agent CLI or login is needed. Never
point the probe at the default session's socket. No screenshots apply: this is
host-only; the phone rendering of status is covered by Home entries.
