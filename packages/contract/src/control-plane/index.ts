export type {
    ApplicationLauncher,
    DesktopCapabilities,
    HerdrRenameTarget,
    DesktopEvent,
    DesktopPermission,
    DesktopSurfaceGeometry,
    ClientRequest,
    ChangesBadge,
    ChangesBrowse,
    ChangesFile,
    ChangesScope,
    ChangesWorktree,
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
export { DESKTOP_CONSENT_WAIT_MS, HERDR_AGENT_NAME_MAX, HERDR_NAME_MAX, MISSING_CWD_ERROR_PREFIX, normalizeRequestFailure, requestRequiresE2ee } from './domain/requests.js';

export type { ClientFrame, PluginsInvalidatedFrame, HostFrame } from './domain/envelope.js';
export {
    decodePayload,
    encodePayload,
    isPluginsInvalidatedFrame,
    nextRequestId,
} from './domain/envelope.js';
export { admitClientFrame, parseClientFrame, tryParseClientFrame } from './application/admitClientFrame.js';

export type { TerminalClientFrame, TerminalHostFrame, TerminalScrollStateFrame } from './infrastructure/terminal.js';
export { newTerminalChannel } from './infrastructure/terminal.js';

export { relayControlUrl, isWebSocketRelayUrl } from './infrastructure/controlPlaneUrl.js';
