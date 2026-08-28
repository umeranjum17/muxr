export type { AgentIdentity, AgentObservation, AgentAdoptInput, NameReservation } from './domain/identity.js';
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
export { createHerdrSessionSource, type CreateHerdrSessionSourceOptions } from './infrastructure/herdrSessionSource.js';
export { assertFakeSourceCoversContract, createFakeSessionSource } from './infrastructure/fakeSessionSource.js';
export { TerminalManager, type TerminalManagerOptions } from './infrastructure/terminalManager.js';
