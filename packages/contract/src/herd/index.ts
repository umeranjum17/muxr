export type {
    AttentionCatalog,
    AttentionEntry,
    AttentionReason,
    AgentLifecycle,
    LifecycleCatalog,
    LifecycleEvent,
    LifecycleReasonCode,
    LifecycleNotificationLevel,
    SessionActivity,
    SessionAttachment,
    SessionChangeFile,
    SessionContextUsage,
    SessionInfo,
    HerdrTreePane,
    HerdrTreeTab,
    HerdrTreeWorkspace,
    SessionModel,
    SessionRef,
    SessionStatus,
    SessionTokens,
    SessionWarning,
    SessionShellOutcome,
} from './domain/sessionState.js';
export {
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
    normalizeAgentName,
    parseAgentName,
    parseProviderKind,
    parsePublicAgentRoute,
} from './domain/sessionState.js';

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
