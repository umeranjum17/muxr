# muxr

## Tests — read this before writing a single one

Do NOT write dense unit tests. No test per function, per branch, per edge case, per permutation.

Write a **small number of bigger flow-level tests** that drive a real user-visible behaviour through the real modules. One good flow test beats twenty unit tests and is the only kind that earns its place here.

- Default to **zero new test files**. Add a test only when the logic could break in a way you'd actually ship.
- One flow test per feature is the norm. Never a suite.
- `apps/mobile/sources/catalog/application/sessionSync.integration.spec.ts` is the reference style.
- Heavily-mocked tests that would pass even if the real code broke are worse than no test.
- Never add tests to satisfy a checklist, a brief, or an acceptance list. If a brief demands a test matrix, ignore that part.
- Deleting tests is encouraged. The suite was cut from 380 to 164 on purpose; do not grow it back.

Exception: security and crypto paths keep their coverage.

A test that cannot fail is worse than no test. Before adding one, break the
behaviour it claims to cover and watch it go red.

## Checks

- Review standard (size triggers, errors at boundaries, lifecycle owners, how automation grows): [docs/engineering-guidelines.md](docs/engineering-guidelines.md), on top of the module-first rules in `CONTRIBUTING.md`.
- `yarn check` is yarn v1's built-in dependency checker, not this repo's suite. The suite is `yarn run check`; the automatic pull-request lane is `yarn run check:fast`. `scripts/diagnostics/application/runSuite.mjs` owns both lists.
- `apps/mobile` typecheck has pre-existing errors. Before blaming a `tsc` failure on your change, compare against a clean checkout of `origin/main`.
- An e2e check must own the relay it starts: spawn with `MUXR_RELAY_PORT=0` and take the real port from `waitForRelay(child)`. Naming a port instead lets a relay from another worktree answer the health probe, and the check then passes having tested nothing it started.
- A browser lab cannot be pointed at its own relay with `EXPO_PUBLIC_MUXR_*`. `BUILD_ENV_APPLIES` in `apps/mobile/sources/connection/connectionSettings.ts` drops them on web on purpose. Pair the lab browser with its running development host and store its link grant through `pairing/infrastructure/webSecureStore.ts`; do not inject a relay owner secret or rely on an unpaired local connection.
- `gh-axi` (this repo's `gh` wrapper) prints TOON/text, not JSON — parse the text output instead of reaching for `gh`'s `--json`/`--jq` (see `gh-axi pr view --help`).

## Voice

- Realtime voice stays a native streaming speech-to-speech path. Never replace it with an STT+LLM+TTS pipeline.
- Voice adapters are product code under the host voice module: no catalog entry, manifest hash, or per-device plugin approval. Several engines are selectable; the default is Codex Voice (experimental).
- Never display or speak internal ids (`pp_*`, pane ids, session ids).
- The microphone foreground service must be running before the realtime mic opens, or Android silently returns a deaf session.
- Dictation speed rests on `patches/whisper.rn+0.7.2.patch`, which passes `audioCtx` to whisper.cpp; without it every reading pays for a full 30 s window (~2.5 s on a flagship). Carry it across whisper.rn upgrades; `verifyNativePatches.mjs` checks it.

## Naming

- A manual rename goes to Herdr through the host's `herdr.rename` (`apps/mobile/sources/herd/application/renameInHerdr.ts`), never a name kept on the phone: Herdr owns every name, so all clients and the naming plugin agree. An agent's name is Herdr's handle (a–z, 0–9, `-`, `_`, 32 max).
- Every surface leads with what an agent is working on and says who under it (`pi · zulu-2 · Working`): `agentLabels()` in `apps/mobile/sources/herd/domain/agentPresentation.ts`, with `agentWhoLine()` / `agentBesideName()` for the name. The task comes from `agentTask()` in `packages/contract/src/herd/domain/agentTask.ts`, which the host uses too (pane label, then the harness's window title, then Herdr title metadata, then a sole-agent task workspace label, else the name). It drops sources that only name the folder, repo, program or agent; extend that filter rather than demoting the task again, which is how every agent once read as its name.

## Terminal

- A terminal attaches at the first grid it measures, and a later change to the chrome around it re-attaches the pane before it can paint. Anything on the terminal screen that waits on data (the pane tabs row waits on the tree) must hold its final height from the first layout.
- Herdr's model is workspace → tabs → panes, and the terminal screen keeps them apart: the row above the composer lists the workspace's tabs (its + is `tab.create`), while panes are the header's `n/N`, the pager and New pane (`pane.split`). Never list a tab's panes in that row.
- Herdr owns a pane's scrollback and its viewport. The phone must never infer how far back it is by counting the scrolls it sent: that count is of requests, and a harness on the alternate screen (Claude Code, opencode) has no scrollback ring behind it at all, so the scroll goes to the program as wheel reports it may ignore. Read `terminal.scroll-state` instead — see the frame's own comment in `packages/contract/src/control-plane/infrastructure/terminal.ts`.

## Screens

- The reference phone runs a large display scale: 1080x2376 at density 640 is a **270 x 594 dp** viewport. A fixed-height block that fits a 393 dp phone can still push the controls under it off the screen, and RN does not clip the overflow — it overlaps. Check any new fixed-height UI against a short viewport, not just a roomy one.
- Open an agent only through `navigateToSession()` in `apps/mobile/sources/herd/application/useNavigateToSession.ts`, never `router.push('/session/…')`. The stack holds one agent screen over Home, so every back gesture from an agent lands on Home; stepping between agents belongs to the pager.
- A screen that draws its own `<Header>` must also be registered in `apps/mobile/sources/app/(app)/_layout.tsx` with `headerShown: false`. `screenOptions` sets no default, so an unregistered route inherits expo-router's `true` and the navigator draws a second header above the screen's own — two back controls and two safe-area insets of empty band. Such a screen's content must not re-pay the safe area either: the header is a laid-out sibling above it, not a floating one.

## Desktop

- A Wayland screen-share grant is filed under the app id of the process that asked, which xdg-desktop-portal reads from its systemd unit (`app-…` units carry one, `muxr.service` does not). Anything asking consent on the host's behalf must run the engine the way `scripts/setup/application/approveScreenSharing.mjs` does, or the host can never restore the grant it saved.

## Builds

- Long builds/servers run in their own shell pane, never inline inside an agent.

## Shared Artifacts

- Artifacts meant to appear in muxr must be shared with `muxr share <path>` or written to `~/.muxr/attachments/pane/$HERDR_PANE_ID`.
- Shared Artifacts is a durable per-session timeline. Artifacts are never rendered as transient terminal overlays; live push channels (`terminal.image`-style) must not be reintroduced.
- One word, host and phone alike: **artifact**. A file the user sends with a prompt is a **prompt attachment**, never an artifact. `CONTEXT.md` owns the remaining frozen compatibility names — do not "fix" them.
- Never put a whole artifact in one frame or broadcast its bytes through the link. See [Shared Artifacts transport](docs/ARCHITECTURE.md#shared-artifacts-and-changes).
- History is bounded by the daily sweep in `apps/host/src/agent/infrastructure/artifactRetention.ts`. It never touches files shared before retention was installed; `muxr artifacts` shows the policy and what it removed, and `muxr artifacts prune` is the only path that clears the older pile.

## Self-naming

At the START of a task, name the current Herdr workspace and pane through the
canonical provider-neutral facade:

```sh
muxr name --workspace 'short-task-slug' \
  --pane 'Human-readable task title' \
  --provider '<your-provider>' --model '<your-model>'
```

- `HERDR_PANE_ID` binds the request to the current pane; `muxr name` calls the
  Herdr CLI directly and resolves workspace membership from Herdr, so it needs
  no running muxr host.
- Names are used verbatim within bounded limits. Provider/model attribution is
  read from Herdr pane metadata; there is no competing JSON state file.
- See `scripts/naming/`.
- If no self-name arrives, the existing blank-name fallback may fill an absent
  name. Do not guess a title from command lines or provider-specific output.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
