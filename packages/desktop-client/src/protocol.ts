/**
 * The wire contract this client speaks, in one place.
 *
 * Two layers, deliberately separate:
 *
 *  - **The engine's local control protocol** (lifecycle, SDP/ICE, clipboard,
 *    metrics). An application carries it over whatever authenticated channel it
 *    already has; this package never assumes a transport.
 *  - **The session's control channel** (pointer, wheel, keys, text), which rides
 *    the WebRTC data channel the engine creates. It belongs to the authorized
 *    media session, so revoking the session closes it.
 *
 * `docs/PROTOCOL.md` in the host engine package is the authority; these types
 * only describe the subset a client needs.
 */

export const PROTOCOL_VERSION = 2;

export type Permission = 'view' | 'control' | 'clipboard';

export interface IceServerConfig {
    urls: string[];
    username?: string;
    credential?: string;
}

/** Geometry of the surface, as the engine reports it after capture starts. */
export interface SurfaceGeometry {
    source: { width: number; height: number };
    encoded: { width: number; height: number };
    /** Origin of the captured source inside the desktop's own layout. */
    origin: { x: number; y: number };
}

export interface SessionOpenRequest {
    permissions: Permission[];
    maxWidth?: number;
    maxHeight?: number;
    bitrateKbps?: number;
    maxFps?: number;
    iceServers?: IceServerConfig[];
    restoreToken?: string;
    ttlSeconds?: number;
}

export interface SessionOpenResult {
    sessionId: string;
    generation: number;
    source: { kind: string; width: number; height: number; origin: { x: number; y: number } };
    geometry: SurfaceGeometry;
}

export interface RtcDescription {
    type: 'offer' | 'answer';
    sdp: string;
}

export interface RtcCandidate {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
}

/** Engine → client lifecycle events, already unwrapped from the local protocol. */
export type SessionEvent =
    | { kind: 'description'; description: RtcDescription }
    | { kind: 'candidate'; candidate: RtcCandidate }
    | { kind: 'state'; capture: string; transport: string; firstFrame: boolean }
    | { kind: 'restoreToken'; token: string }
    | { kind: 'revoked'; reason: string };

/**
 * The application's own authenticated channel to the host engine.
 *
 * The package calls these and nothing else, so an application can carry them
 * over its existing encrypted request path, a socket, or an in-process bridge.
 * `subscribe` delivers engine notifications until the returned function runs.
 */
export interface Signaling {
    /**
     * Send one request. A rejection may carry a stable `code` — the engine's or
     * the host's own token — which the package reads to classify a refusal, so a
     * refusal is not retried as though it were a network failure.
     */
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    subscribe(handler: (event: SessionEvent) => void): () => void;
}

export type SessionStatus =
    | 'idle'
    | 'opening'
    | 'connecting'
    | 'live'
    | 'reconnecting'
    | 'ended'
    | 'failed';

export type SessionFailure =
    | { code: 'permission'; message: string }
    /** Nobody approved the desktop's own screen-sharing prompt in time. */
    | { code: 'consent'; message: string }
    /** The computer has no screen at all and cannot start one (a server without Xvfb). */
    | { code: 'no-screen'; message: string }
    | { code: 'unsupported-codec'; message: string }
    | { code: 'incompatible-version'; message: string }
    | { code: 'source-changed'; message: string }
    | { code: 'revoked'; message: string }
    | { code: 'transport'; message: string }
    | { code: 'input-unavailable'; message: string }
    | { code: 'platform'; message: string };

export interface SessionSnapshot {
    status: SessionStatus;
    /** Geometry is only known once the engine has a consented capture stream. */
    geometry: SurfaceGeometry | null;
    /** True once an authorized, current-generation frame has actually rendered. */
    presented: boolean;
    failure: SessionFailure | null;
    /** Redacted diagnostics: codec, route, counters. Never identities. */
    diagnostics: Record<string, string | number | boolean>;
}

/**
 * Control-channel messages. `seq` is monotonic per generation; the engine
 * refuses a repeat, so a replayed gesture cannot move the pointer twice.
 */
export type ControlMessage =
    | { kind: 'pointer'; phase: 'move' | 'down' | 'up' | 'cancel'; x: number; y: number; button?: number }
    /** Detents; a fraction is a smooth partial scroll where the desktop supports it. */
    | { kind: 'wheel'; dx: number; dy: number }
    | { kind: 'key'; name?: string; character?: string; down: boolean; modifiers?: string[] }
    | { kind: 'text'; text: string }
    | { kind: 'release_all' }
    | { kind: 'clipboard_read'; request: string }
    | { kind: 'clipboard_write'; request: string; text: string };

export type ControlReply =
    | { kind: 'hello'; protocol: number; geometry: SurfaceGeometry }
    | { kind: 'ack'; seq: number }
    | { kind: 'rejected'; seq: number; code: string; message: string }
    | { kind: 'clipboard'; request: string; text: string; truncated?: boolean; error?: string }
    | { kind: 'revoked'; reason: string };

export function parseControlReply(raw: string): ControlReply | null {
    try {
        const parsed = JSON.parse(raw) as ControlReply;
        return typeof parsed?.kind === 'string' ? parsed : null;
    } catch {
        return null;
    }
}
