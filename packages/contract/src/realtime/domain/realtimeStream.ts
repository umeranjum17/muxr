import type { AgentInfo } from '../../herd/index.js';

/**
 * Realtime voice channel. The frame vocabulary, bounds and parsers are
 * @byokit/realtime's; muxr adds only the herd context the host hands its voice
 * child in realtime.open.
 */
export {
    encodeRealtimeFrame,
    MAX_REALTIME_AUDIO_BASE64_BYTES,
    MAX_REALTIME_CLOSE_REASON_BYTES,
    MAX_REALTIME_SDP_BYTES,
    MAX_REALTIME_TEXT_BYTES,
    MAX_REALTIME_WEBRTC_DATA_BYTES,
    newRealtimeChannel,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    REALTIME_INPUT_RATE,
    REALTIME_OUTPUT_RATE,
    realtimePcm16ByteLength,
} from '@byokit/realtime';
export type {
    RealtimeAppAction,
    RealtimeClientFrame,
    RealtimeControlAction,
    RealtimeHostFrame,
    RealtimeState,
} from '@byokit/realtime';

export const MAX_REALTIME_PUBLIC_SESSIONS = 64;

/**
 * The `realtime.state` thinking detail the host sends when a spoken request
 * goes to the planner (seconds, not the direct prompt path). The phone plays a
 * short tone on it so a slow request is not met with silence.
 */
export const REALTIME_PLANNING_DETAIL = 'Working on that request.';

/** Trusted host metadata delivered to the voice child in realtime.open. */
export interface RealtimePluginPublicSession extends AgentInfo {
    sessionId: string;
}

export interface RealtimePluginPublicContext {
    sessions: RealtimePluginPublicSession[];
}

export interface RealtimePluginOpenFrame {
    type: 'realtime.open';
    sessionId?: string;
    paneId?: string;
    cwd?: string;
    publicContext?: RealtimePluginPublicContext;
}
