export type {
    ClientRequest,
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
export type { BrowserSessionTransition } from './domain/requests.js';
export { HOST_CAPABILITY_PROMPT_RECEIPTS, MISSING_CWD_ERROR_PREFIX, PROMPT_ID_PATTERN, PROMPT_SUBMISSION_CLOCK_SKEW_MS, PROMPT_SUBMISSION_MAX_TTL_MS, normalizeRequestFailure, requestRequiresE2ee } from './domain/requests.js';

export type { ClientFrame, Envelope, EnvelopeHeader, PluginsInvalidatedFrame, HostFrame, RoutingChannel, SurfaceOfferHostFrame } from './domain/envelope.js';
export {
    decodePayload,
    encodePayload,
    envelopeIsHosted,
    isPluginsInvalidatedFrame,
    isRoutingChannel,
    isSurfaceOfferHostFrame,
    nextRequestId,
    RELAY_CLOSE_HOST_GONE,
    RELAY_CLOSE_REPLACED,
    ROUTING_CHANNELS,
} from './domain/envelope.js';
export { admitClientFrame, parseClientFrame, tryParseClientFrame } from './application/admitClientFrame.js';

export type {
    SurfaceBrowserDirectOffer,
    SurfaceBrowserLocalOffer,
    SurfaceCapability,
    SurfaceBrowserSessionOffer,
    BrowserSessionState,
    BrowserSessionStatus,
    SurfaceCodeReviewOffer,
    SurfaceOffer,
    SurfaceOfferInput,
    SurfaceOfferKind,
    SurfacePlacement,
} from './domain/surface.js';
export {
    MAX_SURFACE_CONTEXT_LENGTH,
    MAX_SURFACE_LABEL_LENGTH,
    MAX_SURFACE_NAME_LENGTH,
    MAX_SURFACE_PATH_LENGTH,
    MAX_SURFACE_TITLE_LENGTH,
    MAX_SURFACE_URL_LENGTH,
    SURFACE_CAPABILITIES,
    SURFACE_OFFER_KINDS,
    SURFACE_OFFER_VERSION,
    SURFACE_PLACEMENTS,
    isSurfaceCapability,
    isSurfaceOfferHandle,
    isSurfaceSessionId,
    isPublishableSurfaceSession,
    isBrowserSessionHandle,
    isBrowserSessionState,
    cleanSite,
    safeSiteOf,
    BROWSER_SESSION_STATES,
    parseSurfaceOfferInput,
    resolveSurfaceProvider,
    surfaceCapabilityForKind,
} from './domain/surface.js';

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

export type { TerminalClientFrame, TerminalGraphicsReason, TerminalGraphicsSurface, TerminalHostFrame } from './infrastructure/terminal.js';
export { newTerminalChannel, terminalSocketUrl } from './infrastructure/terminal.js';

export { relayControlUrl, isWebSocketRelayUrl, relayChannelSocketUrl } from './infrastructure/controlPlaneUrl.js';
export type { WsTransport } from './infrastructure/wsTickets.js';
export { issueWsTicket, ticketSocketUrl, WsTicketError } from './infrastructure/wsTickets.js';
