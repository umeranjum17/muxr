# Open agent pages on the normal desktop

New agent panes keep the host's desktop environment and tell the agent to open pages on that desktop, where the person watches through Computer. No generic private Browser screen is allocated. Headless Android device mirrors and claimed iOS Simulators remain separate previews.

## Sub-features

- Agent start, split, worktree launch, layout restore and new tab preserve the host's selected desktop (DISPLAY and XAUTHORITY when an X display is selected, otherwise WAYLAND_DISPLAY) without private-screen flags or guidance.
- A plan-account move gives its replacement the same normal-desktop environment.
- Retired or unknown screen targets are refused, never redirected to Computer.

## How to get to it (user POV)

Start an agent from muxr, then ask it to open a page. Open Computer to watch the normal desktop browser. Device preview chips still refer to devices, not browser pages.

## Driving it with the private stack

Preconditions: follow ../SKILL.md isolation. Use a guarded non-default Herdr lab for real launch evidence, not --fake. Use a task-owned HOME, MUXR_HOME, PI_CODING_AGENT_DIR and short TMPDIR. Never open a browser on the owner's desktop for an environment-only check.

1. Build the baseline (origin/main) and candidate in the same disposable worktree, committing work in progress before switching; never create a second checkout or use stash. Record each source commit.
2. In a lab shell pane run the compiled production host SessionSource with the lab socket obtained through the guarded helper, private data/artifact directories and hostHttpPort 0. On the baseline compose the PaneScreens provider exactly as runHost does; on the candidate it is absent. A driver may call the public SessionSource launch operations without a phone or credential-bearing link.
3. Drive `start({ cwd, kind: 'pi' })`, `paneSplit({ sessionId, direction: 'right', kind: 'pi' })` and `createTab(sessionId, { kind: 'pi' })`. Use an isolated agent directory with no copied credentials, and send no agent prompt. Observe each resulting pane in the guarded lab's pane list.
4. Read the actual spawned pane process environment, retaining only DISPLAY, WAYLAND_DISPLAY and XAUTHORITY. Record baseline and candidate values separately. Candidate values must equal the host's selected desktop values: DISPLAY and XAUTHORITY with no WAYLAND_DISPLAY when an X display is selected, WAYLAND_DISPLAY otherwise, never a private display. Record capability copy and absence of private browser arguments through the launch integration flow, not by dumping other process environment.
5. Run `yarn vitest run apps/host/src/agent/infrastructure/herdrSessionSource.launch.test.ts apps/host/src/agent/infrastructure/herdrSessionSource.move.test.ts apps/host/src/desktop/application/androidEmulators.spec.ts`. The launch flow covers all five families, the move flow covers account replacement, and the device flow mirrors a headless emulator through the existing authority/lease path. Break desktop forwarding temporarily and require the launch flow to fail before accepting it.
6. Run CI's `yarn run check:fast` and `yarn run check` locally after `yarn build`, with task-owned TMPDIR for small sockets and large logs on disk. Preserve results, source hashes and selected env evidence outside scratch.
7. Stop only exact owned processes, tear down through the guarded Herdr helper and require its default-session tripwire to pass. Delete scratch, not evidence.

## Gotchas

- An environment-only lab proves launch routing, not that a real page is readable or writable on the phone. The real-desktop journey is a separate acceptance run.
- Do not confuse a worktree launch with a plan-account move; both touch launch env but use different public operations.
- Headless Computer fallback and untargeted Computer requests must not change. Unknown target refusal belongs to the existing desktop integration journey.
- No screen, theme or motion captures apply to this host-only environment check. A browser build is not a substitute for a native phone acceptance run.
