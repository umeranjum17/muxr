export type {
    ApplicationLauncher,
    DesktopCapabilities,
    DesktopIceServer,
    HerdrRenameTarget,
    DesktopEvent,
    DesktopPermission,
    DesktopSurfaceGeometry,
    ClientRequest,
    ChangesBadge,
    ChatMessage,
    ChatImage,
    ChatTool,
    ChatToolKind,
    ChatRead,
    ChangesBrowse,
    ChangesFile,
    ChangesScope,
    ChangesWorktree,
    FilesListing,
    FilesPreview,
    FilesRepo,
    FilesTreeNode,
    HistoryCommitPatch,
    HistoryLog,
    HistoryLogCommit,
    PromptAttachmentAction,
    PromptAttachmentItem,
    MoveOffer,
    MoveReady,
    PeerClientRequest,
    PeerMessageSender,
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
    WatchSettlement,
    LayoutSnapshot,
} from './domain/requests.js';
export { RPC_CLIENT_TIMEOUT_MS, DESKTOP_CONSENT_WAIT_MS, DESKTOP_LOOPBACK_TCP, DESKTOP_NO_PICTURE, DESKTOP_PORTAL_RESTART, DESKTOP_PORTAL_WITHOUT_DESKTOP, desktopPortalBusy, desktopPortalRestartCommand, HERDR_AGENT_NAME_MAX, HERDR_NAME_MAX, MISSING_CWD_ERROR_PREFIX, MOVE_CONTINUE_NOTE, MOVE_MAX_BYTES, normalizeRequestFailure, requestRequiresE2ee, sanitizeRequestErrorMessage } from './domain/requests.js';

export type { ClientFrame, MachineHello, PluginsInvalidatedFrame, HostFrame, ProtocolCompatibility, ProtocolRange } from './domain/envelope.js';
export {
    checkHostProtocol,
    CONTROL_PROTOCOL,
    CONTROL_PROTOCOL_RANGE,
    machineHello,
    decodePayload,
    encodePayload,
    isPluginsInvalidatedFrame,
    nextRequestId,
} from './domain/envelope.js';
export { admitClientFrame, parseClientFrame, tryParseClientFrame } from './application/admitClientFrame.js';

export type { TerminalClientFrame, TerminalHostFrame, TerminalScrollStateFrame } from './infrastructure/terminal.js';
export { newTerminalChannel } from './infrastructure/terminal.js';

export { relayControlUrl, isWebSocketRelayUrl } from './infrastructure/controlPlaneUrl.js';
