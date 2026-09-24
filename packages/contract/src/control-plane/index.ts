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

export type { ClientFrame, Envelope, EnvelopeHeader, PluginsInvalidatedFrame, HostFrame, RoutingChannel } from './domain/envelope.js';
export {
    decodePayload,
    encodePayload,
    envelopeIsHosted,
    isPluginsInvalidatedFrame,
    isRoutingChannel,
    routingChannelForRequest,
    nextRequestId,
    RELAY_CLOSE_REPLACED,
    ROUTING_CHANNELS,
} from './domain/envelope.js';
export { admitClientFrame, parseClientFrame, tryParseClientFrame } from './application/admitClientFrame.js';

export type { PreviewFrame } from './infrastructure/preview.js';
export {
    decodePreviewFrame,
    encodePreviewFrame,
    newPreviewChannel,
    previewSocketUrl,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
    PREVIEW_HEADER_BYTES,
} from './infrastructure/preview.js';

export type { TerminalClientFrame, TerminalHostFrame, TerminalScrollStateFrame } from './infrastructure/terminal.js';
export { newTerminalChannel, terminalSocketUrl } from './infrastructure/terminal.js';

export { relayControlUrl, isWebSocketRelayUrl, relayChannelSocketUrl } from './infrastructure/controlPlaneUrl.js';
export type { WsTransport } from './infrastructure/wsTickets.js';
export { issueWsTicket, ticketSocketUrl, WsTicketError } from './infrastructure/wsTickets.js';
