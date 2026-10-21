# Follow a Herdr agent's status live

The host mirrors every Herdr workspace, pane and agent status the phone shows.
It rides the Herdr kit's own event socket and per-agent status watches, so an
agent going working → blocked → idle reaches Home and the agent screen without
the host opening sockets of its own.

## Sub-features

- A new workspace or pane appears in the host's tree without a restart.
- A status push reuses the tree the kit supplies with its notification; the host does not synchronously clone that whole tree again while indexing the push.
- An agent's status changes (working, blocked, idle) land within a second.
- Listing known agents, opening one, and reading its status/output do not await
  a whole-tree status-watch refresh. Pane-only focus validates the live target
  too; operations needing topology/CWD still await full discovery. Reads retain
  live before/after generation checks and use the kit's epoch-ordered status.
  Listings coalesce background discovery for omitted rename/readiness pushes;
  retained launch-error replay still revalidates before delivery.
- Automatic bootstrap recovery retains the existing 20-second backstop even
  without a passive reader incidentally requesting a refresh.
- The host holds one Herdr socket with no agents, plus exactly one per agent
  (the kit's status watch), and drops it when the pane closes.
- Applying a saved layout starts each recorded agent through the kit's
  `startAgent`, and that agent comes up in the new tab.
- Closing an agent climbs pane → tab → workspace → worktree group on the kit's
  `closePane`/`closeTab`/`closeWorkspace` refusals, asking before each wider
  close; the group ask names the repo and member count from the kit's refusal,
  and a confirmed group close is the kit's confirmed `closeWorkspace`.
  A workspace named for its folder path is asked about by the folder name
  ("Closing umer-app will close this workspace."), never the full path.
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
2. `node .agents/skills/done-done-verify-pockit/features/herdrStatusLab.mjs <socket> <scratch>`
   in the background; keep its PID and log.
3. `run <session> workspace create --label kit-lab`, then
   `run <session> pane report-agent --source lab --agent pi --state working --seq 1 w1:p1`,
   then `blocked` (`--seq 2`) and `idle` (`--seq 3`), then `pane close w1:p1`.
4. After each step count the probe's sockets: `ss -xp | grep "pid=<PID>," | wc -l`.
   Expect 1, 2 with the agent, 1 after close. The log shows
   `kit-lab/w1:p1:pi:working` → `blocked` → `idle` → gone.
5. Layout: `mkdir <scratch>/cwd`, then
   `node .agents/skills/done-done-verify-pockit/features/herdrLayoutLab.mjs <socket> <scratch>/layout <scratch>/cwd`.
   It applies a split whose first pane records `pi` and must print
   `PASS layoutApply started pi via the kit` (a real pi; the lab helper gives it a
   disposable home).
6. Close ladder: `node .agents/skills/done-done-verify-pockit/features/herdrCloseLab.mjs <socket> <scratch>/close`
   (shells only; it makes its own git repo and linked worktree). It must print a
   `PASS` line for the split pane, the tab ask and close, the workspace ask ("Closing workspace will close
   this workspace.": the folder name, not its path) and close, and the group ask ("Closing repo will close 2 workspaces in this
   worktree group.") and close, then `PASS herdrCloseLab`.
7. Starts: `node .agents/skills/done-done-verify-pockit/features/herdrStartLab.mjs <socket> <scratch>/start`
   (a real `pi`, no sign-in). It must print a `PASS` line for the one labelled
   tab, the overlay in the agent process (read from `/proc/<pid>/environ`), the
   reused workspace, the labelled shell, the shell abort and the failed start
   that leaves no workspace, then `PASS herdrStartLab`.
8. SIGTERM the status probe (it disposes the source), then teardown; teardown
   must exit 0.
9. Run `npx vitest run apps/host/src/agent/infrastructure/herdrSessionSource.dupEmit.test.ts` for the real-kit/socket-fixture feed flow: animated title ticks stay quiet, a real metadata change publishes once, and a status push reaches the source without a redundant in-notification tree snapshot. Revert `syncFromKit(snapshot)` to the no-argument call to see that last assertion fail.

10. Run `npx vitest run apps/host/src/agent/infrastructure/herdrSessionSource.codex.test.ts` for the real-kit/socket route flow: list/open/status/output complete while an explicit whole-tree response is held, and text from an unannounced replacement is rejected. Restore the old full-refresh resolver/list to see the pending-read assertion fail.
11. Run `HERDR_LAB_HELPER=<guarded-helper> node scripts/diagnostics/application/checkHerdrVanishedWatch.mjs`. It holds a real status subscription until its pane closes, then requires automatic recovery with the new workspace retained, **without** calling refresh/list/attach to arm recovery; an explicit refresh must still answer afterwards. Capture its log/exit code and successful guarded teardown.

## Gotchas

`report-agent` fakes the lifecycle, so no agent CLI or login is needed. Never
point the probe at the default session's socket. No screenshots apply: this is
host-only; the phone rendering of status is covered by Home entries.
