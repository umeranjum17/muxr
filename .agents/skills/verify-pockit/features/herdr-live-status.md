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

## How to get to it (user POV)

Run agents in Herdr with the host running; Home and the agent screen show each
agent's status as it changes.

## Driving it with the private stack

Preconditions: a built host (`yarn build`) and the guarded lab helper
`fm-herdr-lab.sh` (name, provision, run, teardown); no relay or phone needed.

1. Install one EXIT trap that tears the lab down, then `provision` a named lab
   session and read its `socket_path` from `run <session> session list --json`.
2. `node .agents/skills/verify-muxr/features/herdrStatusLab.mjs <socket> <scratch>`
   in the background; keep its PID and log.
3. `run <session> workspace create --label kit-lab`, then
   `run <session> pane report-agent --source lab --agent pi --state working --seq 1 w1:p1`,
   then `blocked` (`--seq 2`) and `idle` (`--seq 3`), then `pane close w1:p1`.
4. After each step count the probe's sockets: `ss -xp | grep "pid=<PID>," | wc -l`.
   Expect 1, 2 with the agent, 1 after close. The log shows
   `kit-lab/w1:p1:pi:working` → `blocked` → `idle` → gone.
5. SIGTERM the probe (it disposes the source), then teardown; teardown must
   exit 0.

## Gotchas

`report-agent` fakes the lifecycle, so no agent CLI or login is needed. Never
point the probe at the default session's socket. No screenshots apply: this is
host-only; the phone rendering of status is covered by Home entries.
