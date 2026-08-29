# Use cases

Named application modules for operations muxr actually performs. CLI commands, Herdr plugin entries, and menus are adapters. Domain entities own invariants; use cases coordinate them.

There is no `services/` folder. A use case is one camelCase module that exports a function of the same name, takes a small command object (or argv already parsed into one), and returns an explicit result.

## Setup — Machine, Pairing, Connection, Enrollment

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Set up this computer | `applyMachineSetup` | Pairing Intent, Connection | `muxr setup`, interactive menu; `scripts/setup/presentation/setupWizard.mjs` |
| Pair a phone or browser | `pairDevice` | Pairing Intent, Device Id, Device Authority | `muxr pair`, devices menu |
| List paired devices | `listDevices` | Device Id | `muxr devices list` |
| Revoke a device | `revokeDevice` | Device Id, Machine crypto | `muxr devices revoke` |
| Start Self-host relay and host | `startSelfHost` | Connection, Machine | `muxr self-host` |
| Enable browser hosting | `enableBrowserHosting` | Connection | devices menu |
| Connect this Machine to a shared relay | `connectEnrollment` | Enrollment, Machine Id | `muxr connect` |
| Host a shared relay | `hostSharedRelay` | Connection, Ingress | `muxr shared-relay` |
| Connect via remote-relay wizard | `connectRemoteRelay` | Enrollment | advanced menu |
| Create machine Enrollment | `enrollMachine` | Enrollment | `muxr machines enroll` |
| List enrolled machines | `listMachines` | Machine Id | `muxr machines list` |
| Revoke a machine | `revokeMachine` | Machine Id | `muxr machines revoke` |
| Inspect this setup | `inspectSetup` | Connection, Machine | `muxr doctor`, `muxr status` |
| Uninstall muxr | `uninstallMuxr` | Machine | `muxr uninstall` |
| Hosted login | `hostedLogin` | Hosted auth | packed hosted CLI |
| Prompt a peer Agent | `promptPeerAgent` | Agent Route, Agent Name | `muxr peers prompt` |
| List peer machines | `listPeerMachines` | Machine | `muxr peers list` |
| Read a peer Agent session | `readPeerSession` | Agent Route | `muxr peers read` |
| Inspect peer Agent status | `inspectPeerAgent` | Lifecycle Event | `muxr peers status` |
| Watch a peer Agent | `watchPeerAgent` | Agent Watch | `muxr peers watch` |

## Plugin — Plugin Id, Bundled Plugin

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Check a plugin | `checkPlugin` | Plugin Id | `muxr plugin check` |
| Report check result | `reportPluginCheck` | Plugin Id | `muxr plugin check` stdout |
| Create a plugin | `createPlugin` | Plugin Id | `muxr plugin create` |
| Clone a Bundled Plugin | `clonePlugin` | Plugin Id | `muxr plugin clone` |
| Call a plugin RPC | `callPluginAction` | Plugin Id | `muxr plugin call` |
| Link a plugin for development | `linkPlugin` | Plugin Id | `muxr plugin dev` |
| Show plugin docs | `showPluginDocs` | — | `muxr plugin docs` |
| List installed plugins | `listPlugins` | Plugin Id | `muxr plugin list` |
| Install a plugin | `installPlugin` | Plugin Id | `muxr plugin install` |
| Update a plugin | `updatePlugin` | Plugin Id | `muxr plugin update` |
| Remove a plugin | `removePlugin` | Plugin Id | `muxr plugin remove` |

## Voice (bundled Herdr plugins)

Herdr keeps `rpc.mjs` / `stream.mjs` at the plugin root. Those files are adapters.

| Capability | Use case | Domain owner | Adapters |
|---|---|---|---|
| Start an Agent | `startAgent` | Agent, Task Title, Agent Kind | voice coordinator tools |
| Prompt an Agent | `promptAgent` | Agent Route | voice + `muxr peers prompt` |
| List Agents | `listAgents` | Agent | voice `list_agents` |
| Read Agent output | `readAgentSession` | Agent | voice `read_agent_output` |
| Inspect Agent status | `inspectAgentStatus` | Lifecycle Event | voice `agent_status` |
| Watch Agent lifecycle | `watchAgentLifecycle` | Agent Watch | voice `watch_agent` |
| Focus an Agent | `focusAgent` | Agent Route | voice `focus_agent` |
| Report Agent outcome | `reportAgentOutcome` | Voice Report | voice `report` RPC |
| Start realtime conversation | `plugins/voice/stream.mjs` | Realtime Playback, Stream Generation | `host.stream` |
| Interrupt playback | `plugins/voice/stream.mjs` | Realtime Playback, Stream Generation | provider interrupt / `realtime.audio.clear` |
| Store a Provider Secret | `providerSecret` | Provider Secret | voice `key.set` / `key.clear` |

Dictation and terminal key-row plugins are UI-only: Start Dictation and the key row live in the phone kernel (`dictate`, `terminal.key-row`), not in a host use case.

## Release and diagnostics

| Capability | Use case | Adapters |
|---|---|---|
| Pack the npm CLI | `scripts/release/application/pack.mjs` | `yarn pack` |
| Update the installed CLI | `updateCli` | `muxr update` |
| Dump redacted diagnostics | `dumpDiagnostics` | `muxr diagnostics` |

Maintainer flow checks stay under `scripts/diagnostics/application/check*.mjs` and are not product use cases.

## Outside this tooling tree

These operations exist in host/mobile (not rewritten here). Navigate by contract name:

| Capability | Where the behavior lives | Adapters |
|---|---|---|
| Start Agent from the phone | `apps/host` `session.start` / Herdr `agent.start` | mobile session actions |
| Open terminal | relay `/terminal`, mobile xterm | `kernel.navigate` session |
| Open preview | relay `/preview`, `plugins/servers` | `kernel.navigate` preview |
| Grant / revoke peer authority | `apps/host` peer grants | Settings → Computer collaboration |
