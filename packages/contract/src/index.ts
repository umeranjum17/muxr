export type {
    AttentionCatalog,
    AttentionEntry,
    AttentionReason,
    AgentLifecycle,
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
} from './sessionState.js';
export { attentionRank, ATTENTION_REASONS, isSessionIdle } from './sessionState.js';

export type { SessionEvent, SessionEventBody, SessionEventType } from './sessionEvent.js';
export { SESSION_EVENT_TYPES } from './sessionEvent.js';

export type {
    MachineInfo,
    MessagePage,
    SessionSnapshot,
    SessionUnreadEntry,
    UnreadCatalog,
} from './sessionDomain.js';

export type {
    ClientRequest,
    PeerClientRequest,
    PeerRequestMap,
    PeerRequestParams,
    PeerRequestResult,
    PeerRequestType,
    PromptAttachment,
    RequestMap,
    RequestParams,
    RequestResponse,
    RequestResult,
    RequestType,
    StreamingBehavior,
    VoiceProviderOption,
} from './requests.js';
export { MISSING_CWD_ERROR_PREFIX, normalizeRequestFailure, requestRequiresE2ee } from './requests.js';
export type { LayoutSnapshot } from './requests.js';

export type {
    DeviceKind,
    PeerAuthorityMetadata,
    PeerCapability,
    PeerDescriptorClaims,
    PeerMutationMetadata,
    PeerRelationship,
    PeerRelationshipState,
    SignedPeerDescriptor,
} from './peer.js';
export { DEFAULT_PEER_CAPABILITIES, isPeerCapabilities, PEER_CAPABILITIES, peerCapabilityForRequest } from './peer.js';

export type { PreviewFrame } from './preview.js';
export {
    decodePreviewFrame,
    encodePreviewFrame,
    newPreviewChannel,
    previewSocketUrl,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
    PREVIEW_HEADER_BYTES,
} from './preview.js';

export type {
    PluginContribution,
    PluginManifestV1,
    PluginText,
    PluginNativeContribution,
    PluginNativeSlot,
    PluginPrimitive,
    PluginPrimitiveSpec,
    PluginPrimitiveParamRule,
    PluginNativeContextKey,
    PluginAction,
    PluginTerminalKey,
    PluginTerminalKeyRow,
    PluginDataCard,
    PluginEventAction,
    PluginEventTrigger,
    PluginShortcut,
    PluginNavigationItem,
    PluginSettingsItem,
    PluginRow,
    PluginSettingsSection,
    PluginSource,
    PluginSummary,
    PluginToolbarButton,
    PluginRpcCapability,
    PluginStreamCapability,
    PluginRpcMode,
    PluginContextRequest,
    PluginPublicAttentionContext,
    PluginPublicContext,
    PluginPublicSessionContext,
    PluginPublicTreeSession,
    PluginPublicTreeTab,
    PluginPublicTreeWorkspace,
    PluginScreenButtonNode,
    PluginScreenChartNode,
    PluginScreenCodeNode,
    PluginScreenContribution,
    PluginScreenFieldKind,
    PluginScreenFieldNode,
    PluginScreenNode,
    PluginScreenRowAction,
    PluginScreenRowNode,
    PluginScreenTreeNode,
    PluginScreenTone,
} from './plugins.js';
export {
    defaultPluginText,
    resolvePluginText,
    MAX_PLUGIN_LOCALE_TAG_LENGTH,
    MAX_PLUGIN_TEXT_LOCALES,
    PLUGIN_TEXT_MIN_UI_VERSION,
    MAX_RPC_ARRAY_ENTRIES,
    MAX_RPC_CONCURRENCY,
    MAX_RPC_PER_PLUGIN,
    MAX_RPC_PER_DEVICE,
    PLUGIN_CALL_DEADLINE_MS,
    PLUGIN_CALL_KILL_GRACE_MS,
    PLUGIN_CALL_CLIENT_TIMEOUT_MS,
    MAX_RPC_DISPLAY_BYTES,
    MAX_RPC_DISPLAY_DEPTH,
    MAX_RPC_INPUT_BYTES,
    MAX_RPC_RESULT_STRING_BYTES,
    MAX_RPC_STDERR_BYTES,
    MAX_RPC_STDOUT_BYTES,
    MAX_PLUGIN_CONTEXT_ATTENTION,
    MAX_PLUGIN_CONTEXT_BYTES,
    MAX_PLUGIN_CONTEXT_SESSIONS,
    MAX_PLUGIN_CONTEXT_TABS,
    MAX_PLUGIN_CONTEXT_TREE_SESSIONS,
    MAX_PLUGIN_CONTEXT_WORKSPACES,
    MAX_PLUGIN_REFRESH_INTERVAL_MS,
    MIN_PLUGIN_REFRESH_INTERVAL_MS,
    MAX_SCREEN_DEPTH,
    MAX_SCREEN_FIELD_IDS,
    MAX_SCREEN_LIST_ROWS,
    MUXR_UI_VERSION,
    DYNAMIC_SCREEN_MIN_UI_VERSION,
    MAX_CHART_SERIES,
    MAX_CHART_LABEL_BYTES,
    MAX_SCREEN_NODES,
    MAX_SCREEN_OPTIONS,
    NATIVE_SLOTS,
    NATIVE_SLOT_CONTEXT_KEYS,
    PRIMITIVES,
    PRIMITIVE_SPECS,
    PLUGIN_CONTEXT_REQUESTS,
    capUtf8Bytes,
    boundRpcDisplay,
    pluginCompatibilityError,
    sanitizeDisplayText,
} from './plugins.js';

export { parseManifest, parsePluginAction, parsePluginScreenParams } from './manifest.js';

export type { LandWorktreeResult } from './worktree.js';

export type { TerminalClientFrame, TerminalHostFrame } from './terminal.js';
export { newTerminalChannel, terminalSocketUrl } from './terminal.js';
export type { RealtimeClientFrame, RealtimeHostFrame, RealtimeState } from './realtimeStream.js';
export {
    encodeRealtimeFrame,
    MAX_REALTIME_AUDIO_BASE64_BYTES,
    MAX_REALTIME_TEXT_BYTES,
    newRealtimeChannel,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    REALTIME_INPUT_RATE,
    REALTIME_OUTPUT_RATE,
    realtimeSocketUrl,
} from './realtimeStream.js';

export { relayControlUrl } from './controlPlaneUrl.js';
export type { WsTransport } from './wsTickets.js';
export { issueWsTicket, ticketSocketUrl, WsTicketError } from './wsTickets.js';

export type { ClientFrame, Envelope, EnvelopeHeader, PluginsInvalidatedFrame, HostFrame, RoutingChannel } from './wire.js';
export { decodePayload, encodePayload, isPluginsInvalidatedFrame, isValidPluginId, nextRequestId, parseClientFrame, RELAY_CLOSE_REPLACED } from './wire.js';
