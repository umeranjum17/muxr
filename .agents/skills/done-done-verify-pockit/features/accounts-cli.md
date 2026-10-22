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

- `accounts-list` both accounts with email, plan, and both windows with reset times (`--json` too).
- `accounts-start` a new Claude agent runs on the named account; `start auto` is refused.
- `accounts-panes` each agent shows the account it uses, by name and email.
- `accounts-move` the conversation carries to the other account in a new pane; panes then names it.

## How to get to it (user POV)

- A terminal in a Herdr pane, or any shell on the computer running muxr:
  `muxr accounts`, `muxr accounts panes`, `muxr accounts start <account>`,
  `muxr accounts move <agent> <account>`.

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

## Gotchas

- `plans.list` hides a provider with fewer than two accounts, so with one Claude
  account the command says to sign in a second one.
- The quota comes from the host's usage reader; a stand-in has no credentials, so
  the lab feeds the statusline snapshot (`last-statusline-input.json`, under five
  minutes old) the reader falls back to.
- A move needs the agent's conversation id; a stand-in must report it with
  `--source herdr:claude` (see `plan-move.md`).
