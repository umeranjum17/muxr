# Name the current tab and pane

An agent names where it works: `muxr name` renames the current Herdr tab and
pane through Herdr itself and records provider/model attribution, so every
client and the phone agree on the label. It never renames a workspace.

## Sub-features

- `name-pane` sets the pane's human-readable title.
- `name-tab` (`--tab`, old spelling `--workspace`) sets the agent's own tab
  label when the tab holds only its pane; a shared tab keeps its label
  (`"tab":"kept: shared with other panes"`).
- `name-workspace-kept` no workspace is ever renamed, not even one the agent
  started alone in; the phone shows the Herdr label, never a lane's task slug.
- `name-path-label` a workspace Herdr labels with a folder's path keeps that
  label on the phone beside a workspace Herdr named after the same folder,
  never a number (`firstmate 2`).
- `name-attribution` records provider/model pane metadata for display surfaces.
- `name-report` prints the per-field apply result as one JSON line.

## How to get to it (user POV)

- Inside a Herdr pane, run
  `muxr name --tab '<slug>' --pane '<title>' --provider '<provider>' --model '<model>'`
  (any subset; at least one value).
- See the result in Herdr's own workspace/pane listings and in muxr surfaces
  that lead with the task and say who under it.

## Driving it with the private stack

Preconditions:

- A Herdr pane you own in a **non-default** session, with its `HERDR_PANE_ID`
  in the environment (run inside the pane), and the `herdr` binary reachable
  (`HERDR_BIN_PATH`/`HERDR_BIN` when needed).
- The run's `MUXR_HOME` exported as in Launch.

- **Name the pane.** `node scripts/cli.mjs name --pane 'Verify task title'`
  exits `0` with stdout `{"ok":true,"status":"ok","results":{"pane":true}}`.
  Confirm through Herdr, not the CLI echo:
  `herdr --session <yours> pane get "$HERDR_PANE_ID"` shows the new title.
- **Name the tab.** `node scripts/cli.mjs name --tab 'done-done-verify-pockit'`
  exits `0`, `herdr --session <yours> tab list` shows the label, and
  `workspace list` is unchanged.
- **Lead workspace keeps its label (host, no phone).** `done-done run workspace-name-host`
  (`HERDR_LAB_HELPER` set, after `yarn build`): a lane alone in workspace
  `2ndmate-muxr` runs the real `muxr name --workspace boat-live-cli`; `gate.log`
  shows the workspace still `2ndmate-muxr`, the lane's tab `boat-live-cli`, and
  `herdr.tree` carrying a path-labelled workspace beside Herdr's `firstmate`.
- **Shared workspace (phone).** `node .agents/skills/done-done-verify-pockit/features/workspaceNameLab.mjs <apk> <evidence> <labRoot> <cliRepo> [taskTitlesPlugin]`
  (release APK from `node perf/buildPrApk.mjs <out>`, `yarn build`,
  `HERDR_LAB_HELPER` set, under the emulator lock). Workspace `umer-desk` holds
  tabs `fd-prompt-nosript` and `fm-crewhouse`; each lane runs `muxr name
  --workspace <slug>`, the last `ssh-ed25519`, and a lane alone in workspace
  `solo` runs `--workspace solo-task`. Pass: `herdr-after-self-naming.txt`
  keeps the workspaces `umer-desk` and `solo` and shows each lane's tab
  renamed (`solo-task` among them), and Home and Panes (393 dp light, 270 dp
  font 2.0 light and dark) read `umer-desk` and `solo` as workspaces. The scene
  also holds a workspace labelled `/tmp/fmws.XXXX/firstmate` beside one Herdr
  labelled `firstmate` in that folder: Home reads the path label, never
  `firstmate 2`. `spaces-393-1.0-light` is Home scrolled to those two rows.
  The same run carries a lead in an unlabelled tab, agent `firstmate-addons`,
  titled with Claude's doorbell topic: its row reads `Firstmate addons` over
  `claude · Idle`, and the `fm-crewhouse` lead, titled by the task-titles
  plugin, reads `Show the SSH key fingerprint` (see `pane-tab-names.md`).
  `<cliRepo>` at `origin/main` is the before case: the label becomes
  `ssh-ed25519`. With `[taskTitlesPlugin]` (an installed herdr.task-titles
  checkout) a Pi stand-in in an unlabelled tab binds a Pi session transcript
  (`pane report-agent-session` / `report-agent` from `herdr:pi`, as the
  plugin's own journey does) and the plugin's real `hook.mjs` runs on its
  `working` event with `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH` on the lab
  session: `journey.log` shows `"status":"titled"` and the row reads
  `Fix the flaky pairing retry` over `pi · fix-flaky-pairing · Working` (the
  plugin names the agent too). With `<apk>` `pwa` no
  emulator boots: the run prints `browser link: <link>` and holds the lab until
  SIGTERM, for the installed-PWA capture (lab-flag export, then
  `lab-browser-pairing.md` steps 2-4 and the Visual check PWA cells).
  With `MUXR_LAB_SERIAL=a4b93ea2` it runs on the held test phone instead: an
  arm64 APK (`MUXR_PR_APK_ABI=arm64-v8a node perf/buildPrApk.mjs`), the
  adb guard on `PATH`, the journey under `fm-device-lock.sh`. It captures
  `home-phone` and `panes-phone` at the phone's own display settings and
  never runs `pm clear`, which the OnePlus refuses to shell. It dismisses the
  post-pairing notification prompt (`Not now` / `Don't allow`) and grants no
  permission on the phone. A finished run writes done-done's `steps.json`
  (the app version it drove, its start, steps and the watched words the
  captures held). The swiftshader
  emulator can lose its system server to the watchdog on app launch
  (`android.ui` blocked 60 s), so prefer the phone when it is free.
- **Attribution.** `node scripts/cli.mjs name --provider pi --model glm-5.3`
  exits `0`; `herdr --session <yours> pane get "$HERDR_PANE_ID"` (or
  `pane report-metadata` output consumed by display surfaces) carries the
  `provider=` / `model=` tokens from source `muxr.naming`.
- **Outside a pane (failure path).** With `HERDR_PANE_ID` unset, the same
  command exits `1` with stderr
  `muxr name: muxr name must run inside a Herdr pane (HERDR_PANE_ID is missing)`.

## Gotchas

- Names are used verbatim within bounded limits (no control characters; length
  capped). Do not trim or normalize a name to make a check pass — assert the
  rendered label Herdr now holds.
- Workspace membership is resolved from Herdr (`pane get`), never parsed out of
  the pane id string; a pane that Herdr cannot resolve fails loudly with
  `this pane is not available in Herdr`.
- Never run this against the `default` session or any pane you do not own; the
  rename is a real mutation of Herdr state.
- A leading `-` in a pane/workspace name is rejected (flag-injection guard);
  use names that do not start with a dash.
