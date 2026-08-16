import { stripTrailingSlashes } from './controlPlaneUrl.js';

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

export type RealtimeState = 'connecting' | 'connected' | 'thinking' | 'speaking';

export interface RealtimeAudioClientFrame {
    type: 'realtime.audio';
    /** base64 PCM16 mono at the rate named by realtime.ready. */
    data: string;
}

export interface RealtimeControlFrame {
    type: 'realtime.control';
    action: 'mute' | 'unmute' | 'stop';
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

function audio(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REALTIME_AUDIO_BASE64_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error('invalid realtime audio');
    }
    return value;
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
        if (frame.action !== 'mute' && frame.action !== 'unmute' && frame.action !== 'stop') throw new Error('invalid realtime control');
        return { type: 'realtime.control', action: frame.action };
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
        if (frame.state !== 'connecting' && frame.state !== 'connected' && frame.state !== 'thinking' && frame.state !== 'speaking') {
            throw new Error('invalid realtime state');
        }
        return {
            type: 'realtime.state', state: frame.state,
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
    const base = stripTrailingSlashes(relayUrl);
    const parts = [
        `role=${options.role}`,
        `machineId=${encodeURIComponent(options.machineId)}`,
        `channel=${encodeURIComponent(options.channel)}`,
    ];
    if (options.token !== undefined && options.token !== '') parts.push(`token=${encodeURIComponent(options.token)}`);
    return `${base}/stream?${parts.join('&')}`;
}
