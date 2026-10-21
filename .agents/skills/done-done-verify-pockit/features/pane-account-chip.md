# A pane's account chip names only its own agent's account

With two or more accounts for one provider, the terminal header shows a chip
with the plan account the pane's agent runs on (`Pi 1 · Working  [Work]`).
The chip names only the account of that pane's own agent and provider; an
agent with no known account shows no chip.

## Sub-features

- `chip-claude-own` a Claude pane muxr did not start is on the computer's own
  Claude sign-in, so its chip names that account.
- `chip-pi-unknown` a Pi pane muxr did not start signs in to its own
  providers: no chip, even though the computer has a Claude sign-in.
- `chip-pi-launched` a Pi pane muxr started or moved onto a Claude account
  names that account, until the pane reports another provider (`provider`
  pane metadata such as `openai`): then no chip.
- `chip-claude-folder` a Claude pane whose own process runs with a plans
  folder in `CLAUDE_CONFIG_DIR` (not recorded by muxr) names the account signed
  in at that folder, never the computer's default one.

The host decides all four (`withPlanAccounts` in
`apps/host/src/plans/planSignIn.ts`); the phone only paints `planAccount`.
`chip-pi-launched` and the provider switch are covered by the flow test in
`apps/host/src/plans/plansApi.test.ts` (fake Herdr cannot report provider
metadata); the phone drive covers the first two.
`chip-claude-folder` is covered by the flow test and by
`paneAccountChipLab.mjs <apk> <evidenceDir> <labRoot>` (owned emulator, or
`PHONE_SERIAL=a4b93ea2` inside the phone's keeper lock): two Claude panes in a
private Herdr lab, one under the `Work` folder, one on the host's own folder;
the headers must read `On Work` and `On Umer`. The status bar shows the phone owner's notification icons, so the lab keeps
each screen only below it (`*.screen.png`), with the panes cleared first; the
log holds the header text.

## How to get to it (user POV)

- Home › an agent card › the terminal header, right of the agent line.

## Driving it with the private stack

- **Build.** `FM_MEM_JOB_GB=16 fm-mem-gate.sh node perf/buildPrApk.mjs <out>`
  (the chip's renderer is the same on main and the candidate, so one APK serves
  both runs when only host code changed).
- **Lab.** `perf/lib/fakeStack.mjs` with `panes: 2, agents: 2` gives `Pi 1`
  and `Claude 1`, neither started by muxr. Seed a second Claude account the
  way `accountsLab.mjs` does with `LAB_WORK_ACCOUNT=1` (a `Work` record in
  `<muxr home>/plans/accounts-v1.json` plus the stand-in `claude`), and point
  `CLAUDE_CONFIG_DIR` at the found sign-in (`umer@example.com`, named `Umer`).
- **Drive.** Pair (`am start -n com.trymuxr.app/.MainActivity -a
  android.intent.action.VIEW -d 'muxr://pair#<code>'`, tap `Pair`), open
  `muxr://settings/accounts` once so the host lists the accounts (the tree
  names chips from that list), then per cell force-stop, relaunch, tap the
  `Pi 1` card, and run `visualCheck.mjs`. Repeat for `Claude 1`.
- **Before/after.** Run the host once with `apps/host/dist/plans/planSignIn.js`
  compiled from main and once from the candidate.

## Observable results

- Header accessibility label (the Pressable ending `Open panes`):
  main reads `… Pi 1 · Idle. On Umer. … Open panes`; the candidate reads
  `… Pi 1 · Idle. … Open panes` with no `On …`, and no chip is drawn.
- `Claude 1` reads `On Umer` and draws the `Umer` chip on both.
- Shots: `visual/native/<main|candidate>/pi-pane-<width>-<font>-<theme>.png`
  and `claude-pane-270-1.0-dark.png`.
