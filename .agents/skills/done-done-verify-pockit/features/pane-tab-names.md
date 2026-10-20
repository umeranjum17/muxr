# Name panes by their Herdr tab label

After a restart Claude titles every pane with its first chat topic, so a desk
of lead agents all read `Firstmate operational inbox message`. A pane is named
by its own label first, then by its Herdr tab's label exactly as Herdr's
sidebar shows it (even when the launcher gave the agent the same name), and by
its terminal title only when the tab has no label (or Herdr's default bare
number). The line under it says the agent and its state (`claude · Working`). A workspace whose label is
an SSH key's type word (`ssh-ed25519`, `ecdsa-…`, `sk-…`) goes by its panes'
folder instead. The rule is `agentTask()` in
`packages/contract/src/herd/domain/agentTask.ts`; the host drops the key-like
workspace label in `syncFromKit` (`herdrSessionSource.ts`).

## Sub-features

- `pane-tab-name` an agent pane with no pane label leads with its tab label,
  verbatim, on Home and the Panes screen, and its agent name (the same word)
  is not repeated under it.
- `pane-title-fallback` a pane in a tab labelled with a bare number keeps its
  terminal title.
- `workspace-key-label` a workspace labelled `ssh-ed25519` shows its panes'
  folder name, never the key type.

## How to get to it (user POV)

- Pair a computer whose Herdr has agent tabs labelled `fm-<name>` and a
  workspace labelled `ssh-ed25519`, open Home, then the Panes screen.

## Driving it with the private stack

Preconditions:

- `yarn build`, and a release APK from `node perf/buildPrApk.mjs <out>` on an
  owned emulator `SERIAL`; drive the phone over `perf/lib/fakeStack.mjs` with
  `{ panes: 3, agents: 3, titleChurnHz: 0 }`, paired with `mintPairing()` and
  `muxr://pair#<code>`.
- The fake Herdr has no rename method, so seed the world before starting, and
  revert the edit before running the suite: in `perf/fake-herdr/world.mjs` set
  `PANES_PER_TAB = 1`, `KINDS = ['claude']`,
  `TAB_LABELS = ['fd-prompt-nosript', 'fm-crewhouse', '3']`, each agent's
  `name` to its tab's label, the workspace `label` to `'ssh-ed25519'` with no
  `worktree`, every agent pane's title to
  `'Firstmate operational inbox message'`, and no pane `label`.
- For the before shot, build `apps/host` and `packages/contract` from
  `origin/main` and run the same world: every row reads
  `Firstmate operational inbox message` and the space reads `ssh-ed25519`.
- Capture Home and the Panes screen at 393 dp and 270 dp, font 1.0 and 2.0,
  light and dark, through `../SKILL.md`'s Visual check.
- Pass: rows read `fd-prompt-nosript` and `fm-crewhouse` with `claude` and the
  state under them (the `3` tab keeps the title), in Herdr's tab order; the
  space reads the panes' folder (`project`), and `ssh-ed25519` shows nowhere.

## Gotchas

- The tab label skips the noise filter every other source goes through: it
  shows even when it is the agent's own name or the folder's, as in Herdr.
- The phone re-derives the name from each tree pane (`agentLabels`), so a host
  without `tabLabel` on its tree panes keeps the terminal title on the phone
  even when its own `taskTitle` is right.
