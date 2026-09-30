# Host use cases

Navigate by intent. Socket handlers in `host.ts` / `createRequestDispatcher.ts` are adapters.

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Start an Agent | `agent/application/startAgent.ts` | Agent identity (Route authorizes; names never do) | `session.start` dispatcher |
| Choose a Plan Account at launch | `plans/plansApi.ts` (`resolvePlanLaunch`) | Plan Account | `session.start` dispatcher |
| Add or sign in to a Plan Account | `plans/planSignIn.ts` | Plan Account | `plans.add`, `plans.status`, `plans.cancel` |
| Manage or move Plan Accounts | `plans/plansApi.ts`, `agent/infrastructure/herdrSessionSource.ts` | Plan Account / Agent Route | `plans.list`, `plans.rename`, `plans.remove`, `plans.move`, `plans.agent`, `plans.acknowledgeAutoTerms` |
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
| Watch an agent's screen | `desktop/application/previewPresence.ts` | Pane screen presence (measured from mapped windows, never tool-claimed) | `session.list` preview stamp, `desktop.open`/`desktop.capabilities` with `target` |

Not in this process: StartDictation, StartRealtimeConversation, InterruptPlayback — those live on the phone. Voice selection, keys, readiness, and report wording are product use cases in `voice/`, called directly by the dispatcher; only the realtime stream itself is a `SessionSource` method.

Herd layout, artifacts, herdr CLI, and worktree land stay as thin `SessionSource` / infrastructure ports with no extra policy.
