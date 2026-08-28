export type { AgentIdentity, AgentObservation, AgentAdoptInput } from './domain/identity.js';
export { parseTaskTitle, taskTitleFor } from './domain/identity.js';
export { IdentityStore } from './infrastructure/identity.js';
export {
    collectKinds,
    collectPaneIds,
    neighborId,
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from './domain/layout.js';
export { lifecycleReasonForObservation, lifecycleRank, rollupLifecycle } from './domain/lifecycle.js';
export type {
    SessionSource,
    SessionListOptions,
    SessionStartOptions,
    SessionOpenOptions,
    SessionPromptOptions,
    SessionShellOptions,
    SessionShellOutcome,
    SessionReadFileOptions,
    SessionSaveAttachmentsOptions,
} from './application/sessionSource.js';
export { createAgentWatchStores, type AgentWatchStores } from './application/watchStores.js';
export { startAgent } from './application/startAgent.js';
export { promptAgent } from './application/promptAgent.js';
export { openAgent } from './application/openAgent.js';
export { readAgentSession } from './application/readAgentSession.js';
export { watchAgentLifecycle } from './application/watchAgentLifecycle.js';
export { focusAgent } from './application/focusAgent.js';
export { stopAgent } from './application/stopAgent.js';
export { answerAgent } from './application/answerAgent.js';
export { listAgents } from './application/listAgents.js';
export { reportAgentOutcome } from './application/reportAgentOutcome.js';
export { runPluginAction } from './application/runPluginAction.js';
export { openTerminal, closeTerminal } from './application/openTerminal.js';
export { createHerdrSessionSource, type CreateHerdrSessionSourceOptions } from './infrastructure/herdrSessionSource.js';
export { assertFakeSourceCoversContract, createFakeSessionSource } from './infrastructure/fakeSessionSource.js';
export { TerminalManager, type TerminalManagerOptions } from './infrastructure/terminalManager.js';
