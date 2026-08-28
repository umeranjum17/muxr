import { relayChannelSocketUrl } from '../../control-plane/index.js';

/**
 * Provider-neutral realtime voice channel.
 *
 * The phone owns only microphone capture, PCM playback and these generic frames.
 * Provider authentication, event vocabularies, models, tools and prompts live in
 * the host plugin process behind the channel.
 */

export const REALTIME_INPUT_RATE = 24_000;
export const REALTIME_OUTPUT_RATE = 24_000;
export const MAX_REALTIME_AUDIO_BASE64_BYTES = 96 * 1024;
export const MAX_REALTIME_TEXT_BYTES = 4 * 1024;
export const MAX_REALTIME_PUBLIC_SESSIONS = 64;
export const MAX_REALTIME_SDP_BYTES = 128 * 1024;
export const MAX_REALTIME_WEBRTC_DATA_BYTES = 32 * 1024;

/** Trusted host metadata delivered to a stream plugin in realtime.open. */
export interface RealtimePluginPublicSession {
    sessionId: string;
    displayName: string;
    taskTitle?: string;
    agentKind?: string;
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

export type RealtimeState = 'connecting' | 'connected' | 'thinking' | 'speaking';
export type RealtimeControlAction = 'mute' | 'unmute' | 'stop' | 'pause_output' | 'resume_output' | 'output_drained';
export type RealtimeAppAction = 'view' | 'navigate' | 'activate';

export interface RealtimeAudioClientFrame {
    type: 'realtime.audio';
    /** base64 PCM16 mono at the rate named by realtime.ready. */
    data: string;
}

export interface RealtimeControlFrame {
    type: 'realtime.control';
    action: RealtimeControlAction;
}

export interface RealtimeSayFrame {
    type: 'realtime.say';
    text: string;
}

export interface RealtimeAppResultFrame {
    type: 'realtime.app.result';
    requestId: string;
    ok: boolean;
    text: string;
}


export interface RealtimeWebRtcOfferFrame { type: 'realtime.webrtc.offer'; sdp: string }
export interface RealtimeWebRtcDataClientFrame { type: 'realtime.webrtc.data'; data: string }
export type RealtimeClientFrame =
    | RealtimeAudioClientFrame
    | RealtimeControlFrame
    | RealtimeSayFrame
    | RealtimeAppResultFrame
    | RealtimeWebRtcOfferFrame
    | RealtimeWebRtcDataClientFrame;

export interface RealtimeReadyFrame {
    type: 'realtime.ready';
    inputRate: number;
    outputRate: number;
}

export interface RealtimeAudioHostFrame {
    type: 'realtime.audio';
    /** base64 PCM16 mono at realtime.ready's outputRate. */
    data: string;
}

export interface RealtimeAudioClearFrame { type: 'realtime.audio.clear' }
export interface RealtimeStateFrame { type: 'realtime.state'; state: RealtimeState; detail?: string }
export interface RealtimeTranscriptFrame { type: 'realtime.transcript'; role: 'user' | 'agent'; text: string }
export interface RealtimeClosedFrame { type: 'realtime.closed'; reason?: string }
export interface RealtimeAppRequestFrame {
    type: 'realtime.app.request';
    requestId: string;
    action: RealtimeAppAction;
    target?: string;
}

export interface RealtimeWebRtcStartFrame { type: 'realtime.webrtc.start'; dataChannelLabel: string }
export interface RealtimeWebRtcAnswerFrame { type: 'realtime.webrtc.answer'; sdp: string }
export interface RealtimeWebRtcDataHostFrame { type: 'realtime.webrtc.data'; data: string }

export type RealtimeHostFrame =
    | RealtimeReadyFrame
    | RealtimeAudioHostFrame
    | RealtimeAudioClearFrame
    | RealtimeStateFrame
    | RealtimeTranscriptFrame
    | RealtimeAppRequestFrame
    | RealtimeClosedFrame
    | RealtimeWebRtcStartFrame
    | RealtimeWebRtcAnswerFrame
    | RealtimeWebRtcDataHostFrame;

const REALTIME_CONTROL_ACTIONS = new Set<RealtimeControlAction>(['mute', 'unmute', 'stop', 'pause_output', 'resume_output', 'output_drained']);
const REALTIME_APP_ACTIONS: Record<RealtimeAppAction, true> = { view: true, navigate: true, activate: true };
const REALTIME_STATES = new Set<RealtimeState>(['connecting', 'connected', 'thinking', 'speaking']);

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid realtime frame');
    return value as Record<string, unknown>;
}

function boundedText(value: unknown, max: number, label: string): string {
    if (typeof value !== 'string') throw new Error(`invalid realtime ${label}`);
    const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (clean.length === 0 || new TextEncoder().encode(clean).length > max) throw new Error(`invalid realtime ${label}`);
    return clean;
}
function requestId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error('invalid realtime request id');
    return value;
}


const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function realtimePcm16ByteLength(value: unknown): number {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REALTIME_AUDIO_BASE64_BYTES || value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('invalid realtime audio');
    }
    let padding = 0;
    if (value.endsWith('==')) padding = 2;
    else if (value.endsWith('=')) padding = 1;
    const trailingSextet = BASE64_ALPHABET.indexOf(value.charAt(value.length - padding - 1));
    let nonCanonicalPadding = false;
    if (padding === 2) nonCanonicalPadding = (trailingSextet & 15) !== 0;
    else if (padding === 1) nonCanonicalPadding = (trailingSextet & 3) !== 0;
    const bytes = value.length / 4 * 3 - padding;
    if (nonCanonicalPadding || bytes === 0 || bytes % 2 !== 0) throw new Error('invalid realtime audio');
    return bytes;
}

function audio(value: unknown): string {
    realtimePcm16ByteLength(value);
    return value as string;
}

function rate(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || ![8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].includes(value)) {
        throw new Error('invalid realtime audio rate');
    }
    return value;
}

function webRtcSdp(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('v=0') || value.includes('\u0000')
        || new TextEncoder().encode(value).length > MAX_REALTIME_SDP_BYTES) {
        throw new Error('invalid realtime WebRTC SDP');
    }
    return value;
}

function webRtcData(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')
        || new TextEncoder().encode(value).length > MAX_REALTIME_WEBRTC_DATA_BYTES) {
        throw new Error('invalid realtime WebRTC data');
    }
    return value;
}

function dataChannelLabel(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
        throw new Error('invalid realtime WebRTC data channel');
    }
    return value;
}

export function parseRealtimeClientFrame(value: unknown): RealtimeClientFrame {
    const frame = record(value);
    if (frame.type === 'realtime.audio') return { type: 'realtime.audio', data: audio(frame.data) };
    if (frame.type === 'realtime.control') {
        if (typeof frame.action !== 'string' || !REALTIME_CONTROL_ACTIONS.has(frame.action as RealtimeControlAction)) {
            throw new Error('invalid realtime control');
        }
        return { type: 'realtime.control', action: frame.action as RealtimeControlAction };
    }
    if (frame.type === 'realtime.say') return { type: 'realtime.say', text: boundedText(frame.text, MAX_REALTIME_TEXT_BYTES, 'speech') };
    if (frame.type === 'realtime.app.result') {
        if (typeof frame.ok !== 'boolean') throw new Error('invalid realtime app result');
        return {
            type: 'realtime.app.result',
            requestId: requestId(frame.requestId),
            ok: frame.ok,
            text: boundedText(frame.text, MAX_REALTIME_TEXT_BYTES, 'app result'),
        };
    }
    if (frame.type === 'realtime.webrtc.offer') return { type: 'realtime.webrtc.offer', sdp: webRtcSdp(frame.sdp) };
    if (frame.type === 'realtime.webrtc.data') return { type: 'realtime.webrtc.data', data: webRtcData(frame.data) };
    throw new Error('unknown realtime client frame');
}

export function parseRealtimeHostFrame(value: unknown): RealtimeHostFrame {
    const frame = record(value);
    if (frame.type === 'realtime.ready') return { type: 'realtime.ready', inputRate: rate(frame.inputRate), outputRate: rate(frame.outputRate) };
    if (frame.type === 'realtime.audio') return { type: 'realtime.audio', data: audio(frame.data) };
    if (frame.type === 'realtime.audio.clear') return { type: 'realtime.audio.clear' };
    if (frame.type === 'realtime.state') {
        if (typeof frame.state !== 'string' || !REALTIME_STATES.has(frame.state as RealtimeState)) {
            throw new Error('invalid realtime state');
        }
        return {
            type: 'realtime.state', state: frame.state as RealtimeState,
            ...(frame.detail === undefined ? {} : { detail: boundedText(frame.detail, 500, 'state detail') }),
        };
    }
    if (frame.type === 'realtime.transcript') {
        if (frame.role !== 'user' && frame.role !== 'agent') throw new Error('invalid realtime transcript role');
        return { type: 'realtime.transcript', role: frame.role, text: boundedText(frame.text, MAX_REALTIME_TEXT_BYTES, 'transcript') };
    }
    if (frame.type === 'realtime.app.request') {
        if (typeof frame.action !== 'string' || REALTIME_APP_ACTIONS[frame.action as RealtimeAppAction] !== true) {
            throw new Error('invalid realtime app action');
        }
        const action = frame.action as RealtimeAppAction;
        if (action === 'view' && frame.target !== undefined) throw new Error('invalid realtime app target');
        if (action !== 'view' && frame.target === undefined) throw new Error('invalid realtime app target');
        return {
            type: 'realtime.app.request',
            requestId: requestId(frame.requestId),
            action,
            ...(frame.target === undefined ? {} : { target: boundedText(frame.target, 160, 'app target') }),
        };
    }
    if (frame.type === 'realtime.closed') {
        return { type: 'realtime.closed', ...(frame.reason === undefined ? {} : { reason: boundedText(frame.reason, 500, 'close reason') }) };
    }
    if (frame.type === 'realtime.webrtc.start') {
        return { type: 'realtime.webrtc.start', dataChannelLabel: dataChannelLabel(frame.dataChannelLabel) };
    }
    if (frame.type === 'realtime.webrtc.answer') return { type: 'realtime.webrtc.answer', sdp: webRtcSdp(frame.sdp) };
    if (frame.type === 'realtime.webrtc.data') return { type: 'realtime.webrtc.data', data: webRtcData(frame.data) };
    throw new Error('unknown realtime host frame');
}

export function encodeRealtimeFrame(frame: RealtimeClientFrame | RealtimeHostFrame): string {
    return JSON.stringify(frame);
}

/** Random channel id. The relay pairs the two sockets quoting the same one. */
export function newRealtimeChannel(): string {
    return `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Same reachability rule as terminal: derive the channel socket from the session relay URL. */
export function realtimeSocketUrl(
    relayUrl: string,
    options: { machineId: string; channel: string; role: 'machine' | 'client'; token?: string },
): string {
    return relayChannelSocketUrl(relayUrl, 'stream', options);
}
