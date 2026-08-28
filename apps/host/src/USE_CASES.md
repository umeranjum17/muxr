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
| Open / close a terminal | `agent/application/openTerminal.ts` | Device Grant observe/control | `terminal.attach`, `terminal.detach` |
| Reconnect this Machine | `machine/application/reconnectMachine.ts` | Loopback vs ticket admission | `relayLink` |
| List this Machine | `machine/application/listMachines.ts` | Machine | `machines.list` |
| Grant peer authority | `peer/application/grantPeerAuthority.ts` | Device Grant, peer limit | `peer.authorize` |
| Revoke peer authority | `peer/application/revokePeerAuthority.ts` | Device Grant | `peer.revoke` |
| Admit an inbound peer request | `peer/application/admitPeerRequest.ts` | Peer start surface, mutation receipt | PeerRuntime inbound |
| Open / probe Preview | `requests/application/openPreview.ts` | — | `preview.attach`, `preview.probe` |

Not in this process: StartDictation, StartRealtimeConversation, InterruptPlayback — those live on the phone. Host only lists/selects voice providers through `SessionSource`.

Herd layout, attachments, herdr CLI, and worktree land stay as thin `SessionSource` / infrastructure ports with no extra policy.
