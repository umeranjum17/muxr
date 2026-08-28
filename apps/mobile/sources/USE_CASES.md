# Mobile use cases

Named application operations. Each file is one real thing muxr does: a command in, a result out, domain objects and ports in the middle. Routes, hooks, plugin slots, and host adapters call these; they do not own the decision.

Helpers next to use cases (draft state, dock options, live-row order, plugin catalog) are not operations. Do not promote them to use cases and do not dump them in a `services/` folder.

Navigate by capability. Domain language is in the root [CONTEXT.md](../../../CONTEXT.md).

## Phone UI

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Start Agent | `spawn/application/StartAgent.ts` | `SpawnRequest` | `startNewAgent.ts`, `app/(app)/new-agent.tsx` |
| Start Agent from Dock | `spawn/application/StartAgentFromDock.ts` | `WorktreeSelection` | `startSessionFromDraft.ts`, `useStartSessionFromDraft.ts`, Home Dock |
| Land Worktree | `spawn/application/LandWorktree.ts` | Worktree path markers | `useLandWorktree.ts` |
| Focus Agent | `herd/application/FocusAgent.ts` | Agent Route | `useNavigateToSession.ts`, Command Palette, herd rows |
| Watch Agent lifecycle | `herd/application/WatchAgentLifecycle.ts` | Agent, Lifecycle Event | `app/_layout.tsx` (push tap) |
| Pair Machine | `pairing/application/PairMachine.ts` | `PairedMachine` | `usePairing.ts` (confirm + camera), `app/(app)/pair.tsx` |
| Reconnect Machine | `pairing/application/ReconnectMachine.ts` | stored grant vs locator | `useRelayDiscovery.ts` |
| Grant peer authority | `collaboration/application/GrantPeerAuthority.ts` | `Collaboration` | Settings → Collaboration |
| Revoke peer authority | `collaboration/application/RevokePeerAuthority.ts` | `Collaboration` | Settings → Collaboration disconnect |
| Open Terminal | `terminal/application/OpenTerminal.ts` | live pane / Agent Route | `TerminalView` |
| Open Preview | `preview/application/OpenPreview.ts` | `TerminalLink` (loopback HTML) | `session/[id]/preview.tsx` |
| Open Takeover | `takeover/application/OpenTakeover.ts` | coordinates | `session/[id]/takeover.tsx` |
| Run plugin action | `plugins/application/RunPluginAction.ts` | screen/tree models | `pluginActions.ts` (modals + router) |
| Run plugin shortcut | `plugins/application/RunPluginShortcut.ts` | enabled catalog | `app/(app)/shortcut/[id].tsx` |

## Runtime

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Start an Agent | `catalog/application/startAgent.ts` | Agent | `catalog/application/ops.ts` (`machineSpawnNewSession`), `/new-agent`, `StartAgent.ts` |
| Prompt an Agent | `catalog/application/promptAgent.ts` | Agent | `catalog/application/sync.ts` (`sendMessage`), `TerminalScreen.tsx` |
| Read an Agent's workspace file | `catalog/application/readAgentFile.ts` | Agent | `catalog/application/ops.ts` (`sessionReadFile`), `app/(app)/session/[id]/file.tsx` |
| Read a listed Agent | `catalog/application/readAgentSession.ts` | Agent | Catalog store lookups by Agent Route |
| Stop or abort an Agent | `catalog/application/stopAgent.ts` | Agent | `catalog/application/ops.ts` (`sessionKill`, `sessionAbort`) |
| Watch Agent lifecycle on this machine | `watch/application/watchAgentLifecycle.ts` | Agent Watch | `catalog/application/sync.ts` bootstrap |
| Report an Agent outcome | `watch/application/reportAgentOutcome.ts` | Voice Report | `watch/application/wakeAndReport.ts`, plugin `speech.wake` |
| Bind this device to a machine | `pairing/application/PairMachine.ts` | Pairing String, Hosted Grant, PairedMachine | `usePairing.ts`, `app/(app)/pair.tsx` |
| Restore a paired connection | `pairing/application/restoreConnection.ts` | Hosted Grant, Connection | `hostedE2ee.ts` (`restoreHostedConnection`) |
| Forget a pairing on this device | `pairing/application/forgetMachine.ts` | Hosted Grant | `SettingsView.tsx` |
| Focus the Agent for voice | `conversation/application/focusAgent.ts` | Desk Focus, Agent | `realtimeSessionState.ts` (`resolveRealtimeTarget`), `startRealtimeCapability.ts` |
| Start a realtime conversation | `conversation/application/startRealtimeConversation.ts` | Mic Ownership | `realtimeSessionState.ts` (`startRealtimeSession`), `realtimeActions.ts`, plugin `voice.start` |
| Start dictation | `conversation/application/startDictation.ts` | Mic Ownership | `realtimeSessionState.ts` (`claimDictation`), `utils/dictation.ts` |
| Stop a realtime conversation | `conversation/application/stopRealtimeConversation.ts` | Mic Ownership | `realtimeSessionState.ts` (`stopRealtimeSession`) |
| Interrupt playback | `playback/application/interruptPlayback.ts` | Realtime Playback | `@/playback/interrupt`, `realtimeSessionState.ts` (`sleepRealtimeSession`) |
| Validate the account session | `account/application/validateAccountCredential.ts` | Account Credential | `account/application/accountSession.ts`, `catalog/application/sync.ts` |

Claude/Codex rewind, fork, and side-chat stubs in `ops.ts` are not use cases. `machineResumeSession` is a stub ("Resume via session list").
