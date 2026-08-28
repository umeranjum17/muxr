# Mobile use cases

Named application operations for in-scope mobile UI. Each file is one real thing muxr does: a command in, a result out, domain objects and ports in the middle. Hooks, Expo routes, and plugin slots call these; they do not own the decision.

Voice, prompt, and auth live outside this map (`realtime/`, `voice/`, `sync/`, `auth/`). Do not invent a use case for them here.

| Use case | Module | Domain owner | Adapters |
|---|---|---|---|
| Start Agent | `spawn/application/StartAgent.ts` | `SpawnRequest` | `startNewAgent.ts`, `app/(app)/new-agent.tsx` |
| Start Agent from Dock | `spawn/application/StartAgentFromDock.ts` | `WorktreeSelection` | `startSessionFromDraft.ts`, `useStartSessionFromDraft.ts`, Home Dock |
| Land Worktree | `spawn/application/LandWorktree.ts` | Worktree path markers | `useLandWorktree.ts` |
| Focus Agent | `herd/application/FocusAgent.ts` | Agent Route | `useNavigateToSession.ts`, Command Palette, herd rows |
| Watch Agent lifecycle | `herd/application/WatchAgentLifecycle.ts` | Agent, Lifecycle Event | `app/_layout.tsx` (push tap) |
| Pair Machine | `pairing/application/PairMachine.ts` | `PairedMachine` | `usePairing.ts` (confirm + camera) |
| Reconnect Machine | `pairing/application/ReconnectMachine.ts` | stored grant vs locator | `RelayDiscoveryReconnect` |
| Grant peer authority | `collaboration/application/GrantPeerAuthority.ts` | `Collaboration` | Settings → Collaboration |
| Revoke peer authority | `collaboration/application/RevokePeerAuthority.ts` | `Collaboration` | Settings → Collaboration disconnect |
| Open Terminal | `terminal/application/OpenTerminal.ts` | live pane / Agent Route | `TerminalView` |
| Open Preview | `preview/application/OpenPreview.ts` | `TerminalLink` (loopback HTML) | `session/[id]/preview.tsx` |
| Open Takeover | `takeover/application/OpenTakeover.ts` | coordinates | `session/[id]/takeover.tsx` |
| Run plugin action | `plugins/application/RunPluginAction.ts` | screen/tree models | `pluginActions.ts` (modals + router) |
| Run plugin shortcut | `plugins/application/RunPluginShortcut.ts` | enabled catalog | `app/(app)/shortcut/[id].tsx` |

Outside this scope, still real product operations: Prompt Agent, Report Agent outcome, Start dictation, Start realtime conversation, Interrupt playback. Those stay in `sync/` and `realtime/` / `voice/` until that runtime is in scope.

Helpers next to use cases (draft state, dock options, live-row order, plugin catalog) are not operations. Do not promote them to use cases and do not dump them in a `services/` folder.
