# Host use cases

Navigate by intent. Socket handlers in `host.ts` / `createRequestDispatcher.ts` are adapters.

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Start an Agent | `agent/application/startAgent.ts` | Agent identity (Route authorizes; names never do) | `session.start` dispatcher |
| Prompt an Agent | `agent/application/promptAgent.ts` | Agent Route | `session.prompt` |
| Open an Agent | `agent/application/openAgent.ts` | Agent Route | `session.open` |
| Read an Agent session | `agent/application/readAgentSession.ts` | Agent Route | `session.status`, `pane.read`, `session.readFile` |
| Watch Agent lifecycle | `agent/application/watchAgentLifecycle.ts` | Lifecycle Event | `agent.watch` (and peer correlated wait) |
| Focus an Agent | `agent/application/focusAgent.ts` | Layout / Agent Route | `pane.focus`, neighbor focus requests |
| Stop / abort / reload | `agent/application/stopAgent.ts` | Agent Route | `session.stop`, `session.abort`, `session.reload` |
| Answer a blocked Agent | `agent/application/answerAgent.ts` | Agent Route | `session.answer` |
| List Agents | `agent/application/listAgents.ts` | Agent | `session.list`, `client.hello` |
| Report a Lifecycle Event | `agent/application/reportAgentOutcome.ts` | Lifecycle rollup | Herdr session source |
| Run a plugin action | `agent/application/runPluginAction.ts` | Device Grant (view-only reads) | `plugin.*` |
| Open / close a terminal | `agent/application/openTerminal.ts` | Device Grant observe/control | Relay `terminal.attach` / `terminal.detach`; link stream through `machine/infrastructure/linkEndpoint.ts` |
| List this Machine | `machine/application/listMachines.ts` | Machine | `machines.list` |
| Serve paired phones over the link | `machine/infrastructure/linkEndpoint.ts` (`@byokit/link` + `@byokit/relay`) | Device records in `selfhost.json`; link grants are rebuilt from them | `/link/v1/<host id>` through the self-host relay |
| Grant peer authority | `peer/application/grantPeerAuthority.ts` | Device Grant, peer limit | `peer.authorize` |
| Revoke peer authority | `peer/application/revokePeerAuthority.ts` | Device Grant | `peer.revoke` |
| Admit an inbound peer request | `peer/application/admitPeerRequest.ts` | Peer start surface, mutation receipt | PeerRuntime inbound |
| Attach Preview Tunnel | `requests/application/attachPreviewTunnel.ts` | — | `preview.attach` |

Not in this process: StartDictation, StartRealtimeConversation, InterruptPlayback — those live on the phone. Voice selection, keys, readiness, and report wording are product use cases in `voice/`, called directly by the dispatcher; only the realtime stream itself is a `SessionSource` method.

Herd layout, artifacts, herdr CLI, and worktree land stay as thin `SessionSource` / infrastructure ports with no extra policy.
