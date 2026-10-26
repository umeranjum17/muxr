# Manage Claude accounts by hand from the CLI

With two or more signed-in Claude accounts, `muxr accounts` lists them with
what is left in the 5-hour and 7-day windows (and when each resets), shows the
account (name and email) each running agent uses, starts an agent on a named
account and moves a running agent's conversation to another one. Nothing picks
or switches an account on its own: `auto` is refused. The skill text agents
read is the "Claude accounts (by hand)" section of `skills/muxr/SKILL.md`
(`muxr skill`). The phone's header chip and Pane actions › Move to another
account drive the same host requests.

## Sub-features

- `accounts-list` signed-in accounts with stable id, email, plan, and both windows with reset times (`--json` too), even with only one sign-in.
- `accounts-start` a new Claude agent runs on the named account; `start auto` is refused.
- `accounts-panes` each agent shows the account it uses, by name and email.
- `accounts-move` the conversation carries to the other account in a new pane; panes then names it.
- `pane-account` the selected pane's account id/name, or explicit no-agent/no-recorded-account state; defaults to `HERDR_PANE_ID`, supports `--json`.
- `pane-move-to-account` host-owned self-move waits up to five minutes for idle/done, preserves launch flags and resumes the same conversation. The CLI exits after acknowledgement; the replacement has a new pane id.

## How to get to it (user POV)

- A terminal in a Herdr pane, or any shell on the computer running muxr:
  `muxr accounts`, `muxr accounts panes`, `muxr accounts start <account>`,
  `muxr accounts move <agent> <account>`, `muxr pane account [--pane P]`,
  `muxr pane move-to-account <account> [--pane P]`.

## Driving it on a lab Herdr

- `yarn build`, a Herdr lab helper in `HERDR_LAB_HELPER` (see `linkHerdrLab.mjs`).
- `node .agents/skills/done-done-verify-pockit/features/accountsCliLab.mjs <evidence> <labRoot>`
  (a short `<labRoot>` under `~/.cache/fms/`: the lab sockets live under it). It adds
  two stand-in Claude accounts (`Work`, `Home`) through the accounts kit, seeds each
  folder's Claude statusline quota snapshot, and runs the four commands against the
  lab host's `accounts.sock` (`MUXR_DATA_DIR`).
- Pass: `journey.log` ends `PASS`; `cli.txt` holds every command's output (both
  windows with reset times, the new agent on `umer.a@example.com`, the same task
  on `umer.b@example.com` after the move); `pane-after-move.txt` shows the
  earlier turn replayed on the new account.

## Real-account self-move proof

The stand-in journey above is a smoke, not proof that real Claude resumes.
With explicit authorization for two existing sign-ins, seed **only registry
metadata** into the private lab `MUXR_HOME`; externally owned folders are found
rows, never kit-owned. Do not copy, inspect, link or edit login folders. Use the
real host through `linkHerdrLab.mjs`, a private HTTP port and a guarded,
non-default Herdr session. Create one disposable shell through `session.start`,
then launch the installed Claude with `--dangerously-skip-permissions --model
sonnet` in that pane and complete one real turn. Native Claude must use normal
HOME with lab XDG overrides unset and `DISABLE_AUTOUPDATER=1`. The host's lab
pane environment forwards the helper's guarded native wrapper PATH and sets
the opt-out itself. `linkHerdrLab.mjs` preflights the launcher before provisioning:
its resolved target must exist under `~/.local/share/claude/versions`, never lab
data. `checkLabHerdrGuard.mjs` proves valid and escaped/dangling targets against
a synthetic HOME, without touching the installed launcher.

Record the terminal with `script --log-out terminal.typescript --log-timing
terminal.timing`; replay with `scriptreplay --log-out terminal.typescript
--log-timing terminal.timing`. Capture the pane's own terminal before and after
each move through the guarded helper's `pane read`:

```sh
muxr accounts list --json
muxr pane account --pane <A-pane> --json
# Have the agent in A-pane execute this itself, then finish its turn:
muxr pane move-to-account <B-account-id>
muxr pane account --pane <replacement-pane> --json
# Have that resumed agent execute this itself, then finish its turn:
muxr pane move-to-account <A-account-id>
muxr pane account --pane <replacement-pane> --json
```

Read each pane's `agent get` and `pane process-info --pane P` through
`$HERDR_LAB_HELPER run "$HERDR_LAB_SESSION" ...`. Require A→B→A account ids,
identical `agent_session.value` and `--resume` target, unchanged permission/model
flags, and a replacement pane after each issuing CLI has exited. Observe the
handoff acknowledgement in the pane's own tool output, not only the final
account. Close only that disposable pane and stop all owned processes/session.
Refuse before changing anything when there is no conversation, fewer than two
signed-in accounts, a different provider, or another move is already running.

## Gotchas

- The phone still hides providers with fewer than two accounts. The CLI asks
  `plans.list` for lone sign-ins too; starting/moving still requires two.
- The quota comes from the host's usage reader; a stand-in has no credentials, so
  the lab feeds the statusline snapshot (`last-statusline-input.json`, under five
  minutes old) the reader falls back to.
- A move needs the agent's conversation id; a stand-in must report it with
  `--source herdr:claude` (see `plan-move.md`).
