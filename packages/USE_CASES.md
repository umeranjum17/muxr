# Use cases

Named operations muxr actually performs. Domain entities decide invariants; these modules coordinate them. Apps stay thin adapters. There is no `services/` folder.

A package module exists only when the packages own the behavior. Product operations that live in host/mobile are listed here so you navigate by intent, not by inventing empty handlers.

## Package-owned

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Admit a client frame | [`admitClientFrame`](./contract/src/control-plane/application/admitClientFrame.ts) | Envelope, Client Frame | `apps/host/src/relayLink.ts` (`parseClientFrame`) |
| Authorize peer dispatch | [`authorizePeerDispatch`](./contract/src/peer/application/authorizePeerDispatch.ts) | Peer Allowlist | `apps/host/src/peer/runtime.ts` (`dispatchIncoming`) |
| Admit a peer mutation | [`admitPeerMutation`](./contract/src/peer/application/admitPeerMutation.ts) | Peer Mutation | `apps/host/src/peer/receiptExecutor.ts` |
| Parse a plugin manifest | [`parsePluginManifest`](./contract/src/plugins/application/parsePluginManifest.ts) | Plugin Identity, manifest graph | host plugin catalog, mobile `parseManifest` |
| Bound the realtime public Agent map | [`boundRealtimePublicContext`](./contract/src/realtime/application/boundRealtimePublicContext.ts) | Agent Route, Agent Name | `apps/host/src/herdr/pluginStreamManager.ts`, `herdrSessionSource.ts` |
| Interpret a worktree landing | [`interpretWorktreeLanding`](./contract/src/worktree/application/interpretWorktreeLanding.ts) | Worktree Landing | `apps/host/src/requests/landWorktree.ts`, `apps/mobile/sources/utils/worktree.ts` |
| Pair a machine | [`pairMachine`](./crypto/src/e2ee/application/pairMachine.ts) | Pairing Code | `apps/mobile/sources/pairing/application/hostedE2ee.ts`, `usePairing.ts` |
| Grant or verify device authority | [`deviceGrant`](./crypto/src/e2ee/application/deviceGrant.ts) | Device Grant | `apps/host/src/peer/runtime.ts`, `hostedE2ee.ts` (`createDeviceGrant` / `verifyDeviceGrant`) |
| Sign a peer descriptor | [`signPeerDescriptor`](./crypto/src/e2ee/application/signPeerDescriptor.ts) | Signed Peer Descriptor | host peer prepare/install |
| Install a peer bundle | [`installPeerBundle`](./crypto/src/e2ee/application/installPeerBundle.ts) | Device Grant, Peer Descriptor | `peer.install` in `apps/host/src/peer/runtime.ts` |
| Seal or open a v2 envelope | [`envelope`](./crypto/src/e2ee/application/envelope.ts) | Routing Channel, Device Grant | host/mobile `hostedE2ee`, `openV2` / `sealV2` |
| Seal preview bytes | [`previewChannel`](./crypto/src/e2ee/application/previewChannel.ts) | Preview channel keys | `apps/host/src/requests/preview.ts`, `apps/mobile/sources/preview/openPreview.ts` |

`issueWsTicket` stays control-plane infrastructure: it talks HTTP. Do not wrap it in a fake port.

## App-owned (call package domain; do not stub here)

| Capability | Request / entry | Domain owner | Adapters |
|---|---|---|---|
| Start Agent | `session.start` | Herd (Agent Route, Agent Name, Agent Kind) | `apps/host/src/requests/createRequestDispatcher.ts`, `apps/mobile/sources/catalog/application/ops.ts` |
| Prompt Agent | `session.prompt` | Herd | dispatcher, `apps/mobile/sources/catalog/application/sync.ts` |
| Read Agent Session | `pane.read` | Herd, control-plane | dispatcher, `TerminalPreview.tsx` |
| Watch Agent Lifecycle | `agent.watch` | Agent Watch, Lifecycle Event | dispatcher, `apps/mobile/sources/watch/application/agentWatch.ts` |
| Focus Agent | `pane.focus` | Agent Route | dispatcher, `herdrSessionSource.ts` |
| Reconnect Machine | stored Device Grant refresh | Device Grant | `hostedE2ee.ts` (`refreshHostedGrant`), `sync.ts` |
| Grant Peer Authority | `peer.authorize` | Peer Allowlist, Device Grant | `apps/host/src/peer/runtime.ts` |
| Revoke Peer Authority | `peer.revoke` | Peer relationship | `runtime.ts`, `apps/mobile/sources/collaboration/computerCollaboration.ts` |
| Start Dictation | on-device dictation | Realtime (phone capture only) | `apps/mobile/sources/utils/dictation.ts` |
| Start Realtime Conversation | `voice.session` stream | Realtime frames | `apps/mobile/sources/conversation/application/realtimeSession.ts` |
| Interrupt Playback | `pause_output` / `stop` | Realtime control | `apps/mobile/sources/playback/infrastructure/realtimePlayback.ts` |
| Report Agent Outcome | `voice.report` | Voice Report, Agent Lifecycle | `apps/mobile/sources/watch/application/wakeAndReport.ts` |
| Open Terminal | terminal channel | Routing Channel `terminal` | `apps/mobile/sources/terminal/openTerminal.ts`, `apps/host/src/herdr/terminalManager.ts` |
| Open Preview | preview channel | Routing Channel `attachment` / preview | `openPreview.ts`, host `preview.ts` |
| Run Plugin Action | `plugin.call` / `plugin.invoke` | Plugin Identity | dispatcher, `screenModel.ts`, `usePluginEvents.ts` |

## Convention

Each package use case is one file named for the operation. It takes a small command or value object, talks only to same-context domain and infrastructure (or another context's `index.ts`), and returns an explicit result (`Outcome`, a decision union, or a sealed payload). No React, sockets, CLI flags, or native modules.

Throwing aliases (`parseClientFrame`, `parseManifest`, `normalizePairingCode`, `verifyDeviceGrant`, `openV2`) stay for existing adapters. New code should call the named use case.
