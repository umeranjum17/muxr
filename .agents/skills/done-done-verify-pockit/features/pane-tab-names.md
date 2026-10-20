# Name panes by their Herdr tab label

After a restart Claude titles every pane with its first chat topic, so a desk
of lead agents all read `Firstmate operational inbox message`. A pane is named
by its Herdr tab's label first, exactly as Herdr's sidebar shows it (even when
the launcher gave the agent the same name), then by its own pane label, and by
its terminal title only when neither names it (a tab labelled with Herdr's
default bare number names nothing). The line under it says the agent and its state (`claude · Working`). A workspace whose label is
an SSH key's type word (`ssh-ed25519`, `ecdsa-…`, `sk-…`) goes by its panes'
folder instead. The rule is `agentTask()` in
`packages/contract/src/herd/domain/agentTask.ts`; the host drops the key-like
workspace label in `syncFromKit` (`herdrSessionSource.ts`).

## Sub-features

- `pane-tab-name` an agent pane leads with its tab label,
  verbatim, on Home and the Panes screen, and its agent name (the same word)
  is not repeated under it.
- `pane-title-fallback` a pane in a tab labelled with a bare number keeps its
  terminal title (the host naming test drives it).
- `workspace-key-label` a workspace labelled `ssh-ed25519` shows its panes'
  folder name, never the key type.

- `pane-name-live` after a Herdr restart, and after a tab relabel with no
  restart, the rows read Herdr's current labels; nothing first-seen sticks.

## How to get to it (user POV)

- Pair a computer whose Herdr has agent tabs labelled `fm-<name>` and a
  workspace labelled `ssh-ed25519`, open Home, then the Panes screen.

## Driving it on a lab Herdr

- `yarn build`, a release APK from `node perf/buildPrApk.mjs <out>`, and a
  Herdr lab helper in `HERDR_LAB_HELPER` (see `linkHerdrLab.mjs`); take the
  emulator lock as in `../SKILL.md`.
- `node .agents/skills/done-done-verify-pockit/features/paneTabNamesLab.mjs <apk> <evidence> <labRoot>`
  (a short `<labRoot>`: the lab sockets live under it). It builds a workspace
  labelled `ssh-ed25519` with tabs `fd-prompt-nosript`, `fm-crewhouse` (claude
  stand-ins) and `fm-muxr` (a codex stand-in), every terminal titled
  `Firstmate operational inbox message`, pairs the APK to a lab host, captures,
  restarts the lab Herdr through the helper, captures Home and Panes at 393 and
  270 dp, font 1.0 and 2.0, light and dark, then relabels `fm-crewhouse` to
  `fm-office` and captures Panes again. `herdr-*.txt` keeps Herdr's own
  workspace, tab and agent lists beside each step.
- Pass: rows read the tab labels in Herdr's tab order with `claude · Idle` /
  `codex · Idle` under them, the space reads `muxr`, `ssh-ed25519` and the
  Claude title show nowhere, and the relabelled row reads `fm-office`.

## Gotchas

- The tab label skips the noise filter every other source goes through: it
  shows even when it is the agent's own name or the folder's, as in Herdr.
- The phone re-derives the name from each tree pane (`agentLabels`), so a host
  without `tabLabel` on its tree panes keeps the terminal title on the phone
  even when its own `taskTitle` is right.
- Herdr restores tabs and labels on restart but not the stand-in processes; the
  journey restarts them, as a resumed Claude would.
- The guarded helper refuses `session attach`, so there is no capture of
  Herdr's own sidebar; the `herdr-*.txt` lists are what it draws.
