export type {
    AttentionCatalog,
    AttentionEntry,
    AttentionReason,
    AgentInstallState,
    AgentLifecycle,
    AgentInfo,
    LifecycleCatalog,
    LifecycleEvent,
    LifecycleReasonCode,
    LifecycleNotificationLevel,
    SessionActivity,
    SessionArtifact,
    SessionArtifactMetadata,
    SessionChangeFile,
    SessionContextUsage,
    SessionInfo,
    PreviewPresence,
    HerdrTreePane,
    HerdrTreeTab,
    HerdrTreeWorkspace,
    SessionModel,
    SessionRef,
    CloseResult,
    CloseScope,
    SessionStatus,
    SessionTokens,
    SessionWarning,
    SessionShellOutcome,
} from './domain/sessionState.js';
export {
    AGENT_INSTALL_STATES,
    AGENT_LIFECYCLES,
    ATTENTION_DONE_TTL_MS,
    ATTENTION_HARD_CAP_MS,
    ATTENTION_REASONS,
    agentIsWorking,
    agentRoute,
    attentionOutranks,
    attentionRank,
    attentionReasonStillHolds,
    isSessionIdle,
    lifecycleEventAgentName,
    LIFECYCLE_NOTIFICATION_LEVELS,
    lifecycleNotificationAllowed,
    lifecycleEventRoute,
    parseAgentLifecycle,
    parseLifecycleNotificationLevel,
    parseAgentName,
    parseCloseResult,
    parseCloseScope,
    parseProviderKind,
    parsePublicAgentRoute,
    CLOSE_SCOPES,
} from './domain/sessionState.js';

export type { AgentTaskSources } from './domain/agentTask.js';
export { agentAlertTitle, agentTask } from './domain/agentTask.js';

export type { SessionEvent, SessionEventBody, SessionEventType } from './domain/sessionEvent.js';
export { SESSION_EVENT_TYPES } from './domain/sessionEvent.js';

export type {
    MachineInfo,
    MessagePage,
    SessionSnapshot,
    SessionStartResult,
    SessionUnreadEntry,
    UnreadCatalog,
} from './domain/sessionDomain.js';
export { startWasAccepted } from './domain/sessionDomain.js';
