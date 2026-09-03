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
    WatchSettlement,
    LayoutSnapshot,
} from './domain/requests.js';
export { MISSING_CWD_ERROR_PREFIX, normalizeRequestFailure, requestRequiresE2ee } from './domain/requests.js';

export type { ClientFrame, Envelope, EnvelopeHeader, PluginsInvalidatedFrame, HostFrame, RoutingChannel } from './domain/envelope.js';
export {
    decodePayload,
    encodePayload,
    envelopeIsHosted,
    isPluginsInvalidatedFrame,
    isRoutingChannel,
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

export type { TerminalClientFrame, TerminalGraphicsReason, TerminalHostFrame } from './infrastructure/terminal.js';
export { newTerminalChannel, terminalSocketUrl } from './infrastructure/terminal.js';

export { relayControlUrl, isWebSocketRelayUrl, relayChannelSocketUrl } from './infrastructure/controlPlaneUrl.js';
export type { WsTransport } from './infrastructure/wsTickets.js';
export { issueWsTicket, ticketSocketUrl, WsTicketError } from './infrastructure/wsTickets.js';
