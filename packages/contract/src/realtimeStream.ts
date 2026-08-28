import { relayChannelSocketUrl } from './controlPlaneUrl.js';

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

/** Bound and sanitize the stable-id/name map before it crosses the stream process boundary. */
export function realtimePluginPublicContext(input: readonly RealtimePluginPublicSession[]): RealtimePluginPublicContext {
    const sessions: RealtimePluginPublicSession[] = [];
    const ids = new Set<string>();
    for (const entry of input) {
        const sessionId = entry.sessionId.replace(/[\0-\x1F\x7F]/g, '').trim();
        const displayName = entry.displayName.normalize('NFKC').replace(/[\0-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
        if (!/^[A-Za-z0-9._:-]{1,80}$/.test(sessionId) || ids.has(sessionId)) continue;
        if (!/^[\p{L}\p{M}][\p{L}\p{M}' -]{0,72}(?: \d+)?$/u.test(displayName)) continue;
        const agentKind = entry.agentKind?.trim().toLowerCase();
        let taskTitle = entry.taskTitle?.replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (taskTitle !== undefined) {
            for (const prefix of [displayName, agentKind]) {
                if (prefix === undefined || prefix === '') continue;
                const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                taskTitle = taskTitle.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
            }
            if (taskTitle === '' || taskTitle.split(/\s+/).length > 8 || /[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(taskTitle)) taskTitle = undefined;
        }
        ids.add(sessionId);
        sessions.push({
            sessionId,
            displayName,
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(agentKind === undefined || !/^[a-z][a-z0-9_-]{0,31}$/.test(agentKind) ? {} : { agentKind }),
        });
        if (sessions.length === MAX_REALTIME_PUBLIC_SESSIONS) break;
    }
    return { sessions };
}

export type RealtimeState = 'connecting' | 'connected' | 'thinking' | 'speaking';
export type RealtimeControlAction = 'mute' | 'unmute' | 'stop' | 'pause_output' | 'resume_output' | 'output_drained';

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

export type RealtimeClientFrame = RealtimeAudioClientFrame | RealtimeControlFrame | RealtimeSayFrame;

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

export type RealtimeHostFrame =
    | RealtimeReadyFrame
    | RealtimeAudioHostFrame
    | RealtimeAudioClearFrame
    | RealtimeStateFrame
    | RealtimeTranscriptFrame
    | RealtimeClosedFrame;

const REALTIME_CONTROL_ACTIONS = new Set<RealtimeControlAction>(['mute', 'unmute', 'stop', 'pause_output', 'resume_output', 'output_drained']);
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
    if (frame.type === 'realtime.closed') {
        return { type: 'realtime.closed', ...(frame.reason === undefined ? {} : { reason: boundedText(frame.reason, 500, 'close reason') }) };
    }
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
