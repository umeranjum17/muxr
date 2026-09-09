import { realtimePcm16ByteLength, type RealtimeControlAction } from '@muxr/contract';
import {
    clearRealtimePcm, finishRealtimePcm, isRealtimePcmDrained, playRealtimePcm, releaseVoiceAudio,
    routeVoiceAudio, startRealtimePcm, stopRealtimePcm,
} from '@/../modules/voice-overlay';

const MAX_OUTPUT_BYTES = 192_000;
const OUTPUT_LOW_WATER_BYTES = 48_000;
const RETRY_MS = 20;

type PlaybackControl = Extract<RealtimeControlAction, 'pause_output' | 'resume_output' | 'output_drained'>;
export type PlaybackSink = {
    send: (frame: { type: 'realtime.control'; action: PlaybackControl }) => boolean;
};
export type PlaybackBoundary = 'connected' | 'speech';
export type PlaybackAdmit = 'ok' | 'malformed' | 'overflow';

type BoundaryCallback = { generation: number; streamGeneration: number; kind: PlaybackBoundary; run: () => void };
type QueuedAudio = { type: 'audio'; data: string; bytes: number; queued: boolean };
type FinishMarker = { type: 'finish'; token: number; started: boolean; streamGeneration: number; callbacks: BoundaryCallback[] };
type OutputItem = QueuedAudio | FinishMarker;

export interface RealtimePlayback {
    readonly stats: {
        received: number;
        queued: number;
        dropped: number;
        cleared: number;
        playbackClears: number;
        playbackUnderruns: number;
        nativePeak: number;
    };
    ensure: (sampleRate: number) => void;
    bind: (sink: PlaybackSink) => void;
    unbind: (sink: PlaybackSink) => void;
    admit: (data: string) => PlaybackAdmit;
    clear: () => void;
    finish: (onDrained?: () => void) => boolean;
    afterDrain: (kind: PlaybackBoundary, run: () => void) => boolean;
    stop: () => void;
    release: () => void;
}

function nativeStat(record: Record<string, unknown>, name: string): number {
    const value = record[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return value;
}

/**
 * Native PCM output for one voice call. Queue, backpressure, drain, and
 * stream-generation fencing live here so a replacement stream cannot be
 * acknowledged for audio it did not produce.
 */
export function createRealtimePlayback(): RealtimePlayback {
    let stopped = false;
    let stream: PlaybackSink | undefined;
    let pausedStream: PlaybackSink | undefined;
    let sampleRate: number | undefined;
    let outputRetry: ReturnType<typeof setTimeout> | undefined;
    let drainRetry: ReturnType<typeof setTimeout> | undefined;
    let controlRetry: ReturnType<typeof setTimeout> | undefined;
    let outputGeneration = 0;
    let streamGeneration = 0;
    let finishSequence = 0;
    let outputNeedsFinish = false;
    let outputPressured = false;
    let outputBytes = 0;
    const outputQueue: OutputItem[] = [];
    const pendingCallbacks: BoundaryCallback[] = [];
    const stats = {
        received: 0,
        queued: 0,
        dropped: 0,
        cleared: 0,
        playbackClears: 0,
        playbackUnderruns: 0,
        nativePeak: 0,
    };

    const collectNativeStats = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        const native = value as Record<string, unknown>;
        stats.playbackUnderruns += nativeStat(native, 'underruns');
        stats.playbackClears += nativeStat(native, 'clears');
        stats.nativePeak = Math.max(
            stats.nativePeak,
            nativeStat(native, 'peakQueuedMs'),
            nativeStat(native, 'peakQueuedBytes'),
            nativeStat(native, 'peak'),
        );
    };
    const sendControl = (action: PlaybackControl): boolean => {
        if (stream === undefined) return false;
        try { return stream.send({ type: 'realtime.control', action }); } catch { return false; }
    };
    const scheduleControl = (): void => {
        if (stopped || controlRetry !== undefined) return;
        controlRetry = setTimeout(() => { controlRetry = undefined; flushControl(); }, RETRY_MS);
    };
    const flushControl = (): void => {
        if (stopped || stream === undefined) {
            if (outputPressured) scheduleControl();
            return;
        }
        if (outputPressured) {
            if (pausedStream === stream) return;
            if (!sendControl('pause_output')) {
                scheduleControl();
                return;
            }
            pausedStream = stream;
            return;
        }
        if (pausedStream !== stream) return;
        if (!sendControl('resume_output')) {
            scheduleControl();
            return;
        }
        pausedStream = undefined;
    };
    const scheduleOutputFlush = (generation: number): void => {
        if (stopped || outputRetry !== undefined) return;
        outputRetry = setTimeout(() => {
            outputRetry = undefined;
            if (generation === outputGeneration) flushOutput(generation);
        }, RETRY_MS);
    };
    const latestQueuedFinish = (): FinishMarker | undefined => {
        for (let index = outputQueue.length - 1; index >= 0; index -= 1) {
            const item = outputQueue[index];
            if (item.type === 'finish') return item;
        }
        return undefined;
    };
    const afterDrain = (kind: PlaybackBoundary, run: () => void): boolean => {
        const callback = { generation: outputGeneration, streamGeneration, kind, run };
        const marker = latestQueuedFinish();
        if (marker !== undefined) {
            marker.callbacks.push(callback);
            return true;
        }
        if (!outputNeedsFinish) return false;
        pendingCallbacks.push(callback);
        return true;
    };
    const runBoundaryCallbacks = (callbacks: BoundaryCallback[]): void => {
        const speechIsWaiting = callbacks.some((callback) => callback.kind === 'speech');
        for (const callback of callbacks) {
            if (callback.generation !== outputGeneration) continue;
            if (callback.streamGeneration !== streamGeneration) continue;
            if (speechIsWaiting && callback.kind === 'connected') continue;
            callback.run();
        }
    };
    const completeFinish = (marker: FinishMarker): void => {
        outputQueue.shift();
        if (marker.callbacks.length === 0) return;
        const nextFinish = outputQueue.find((item): item is FinishMarker => item.type === 'finish');
        if (nextFinish !== undefined) {
            nextFinish.callbacks.unshift(...marker.callbacks);
            return;
        }
        if (outputQueue.length > 0) {
            pendingCallbacks.push(...marker.callbacks);
            return;
        }
        runBoundaryCallbacks(marker.callbacks);
    };
    const flushOutput = (generation = outputGeneration): void => {
        while (!stopped && generation === outputGeneration && outputQueue.length > 0) {
            const head = outputQueue[0];
            if (head.type === 'finish') {
                if (outputBytes <= OUTPUT_LOW_WATER_BYTES) {
                    outputPressured = false;
                    flushControl();
                }
                if (!head.started && !finishRealtimePcm()) {
                    scheduleOutputFlush(generation);
                    return;
                }
                head.started = true;
                if (!isRealtimePcmDrained()) {
                    if (drainRetry === undefined) {
                        const token = head.token;
                        drainRetry = setTimeout(() => {
                            drainRetry = undefined;
                            const current = outputQueue[0];
                            if (generation === outputGeneration && current?.type === 'finish' && current.token === token) {
                                flushOutput(generation);
                            }
                        }, RETRY_MS);
                    }
                    return;
                }
                const drainBelongsToCurrentStream = stream !== undefined && head.streamGeneration === streamGeneration;
                if (drainBelongsToCurrentStream && !sendControl('output_drained')) {
                    scheduleOutputFlush(generation);
                    return;
                }
                completeFinish(head);
                continue;
            }
            if (!playRealtimePcm(head.data)) {
                if (!head.queued) {
                    head.queued = true;
                    stats.queued += 1;
                }
                outputPressured = true;
                flushControl();
                scheduleOutputFlush(generation);
                return;
            }
            outputQueue.shift();
            outputBytes -= head.bytes;
        }
        if (!stopped && generation === outputGeneration && outputQueue.length === 0 && outputBytes <= OUTPUT_LOW_WATER_BYTES) {
            outputPressured = false;
            flushControl();
        }
    };
    const finish = (onDrained?: () => void): boolean => {
        if (stopped || sampleRate === undefined) return false;
        if (!outputNeedsFinish) {
            if (onDrained === undefined) return false;
            return afterDrain('connected', onDrained);
        }
        outputNeedsFinish = false;
        const callbacks = pendingCallbacks.splice(0);
        if (onDrained !== undefined) {
            callbacks.push({ generation: outputGeneration, streamGeneration, kind: 'connected', run: onDrained });
        }
        outputQueue.push({ type: 'finish', token: ++finishSequence, started: false, streamGeneration, callbacks });
        flushOutput();
        return onDrained !== undefined;
    };
    const clear = (): void => {
        outputGeneration += 1;
        for (const timer of [outputRetry, drainRetry, controlRetry]) if (timer !== undefined) clearTimeout(timer);
        outputRetry = drainRetry = controlRetry = undefined;
        stats.cleared += outputQueue.filter((item) => item.type === 'audio').length;
        outputQueue.length = 0;
        pendingCallbacks.length = 0;
        outputBytes = 0;
        outputNeedsFinish = false;
        outputPressured = false;
        flushControl();
        if (sampleRate !== undefined) clearRealtimePcm();
    };
    const playback: RealtimePlayback = {
        stats,
        ensure: (rate) => {
            if (sampleRate === rate) return;
            if (sampleRate !== undefined) {
                try { collectNativeStats(stopRealtimePcm()); } catch { /* rate change still has to start the new player */ }
            }
            if (!routeVoiceAudio() || !startRealtimePcm(rate)) throw new Error('This device could not start realtime audio.');
            sampleRate = rate;
        },
        bind: (next) => {
            stream = next;
            streamGeneration += 1;
            flushControl();
            flushOutput();
        },
        unbind: (previous) => {
            if (stream !== previous) return;
            stream = undefined;
            if (pausedStream === previous) pausedStream = undefined;
        },
        admit: (data) => {
            if (stopped) return 'ok';
            let bytes: number;
            try { bytes = realtimePcm16ByteLength(data); } catch { return 'malformed'; }
            stats.received += 1;
            if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
                stats.dropped += 1;
                return 'overflow';
            }
            outputQueue.push({ type: 'audio', data, bytes, queued: false });
            outputBytes += bytes;
            outputNeedsFinish = true;
            flushOutput();
            return 'ok';
        },
        clear,
        finish,
        afterDrain,
        stop: () => {
            stopped = true;
            for (const timer of [outputRetry, drainRetry, controlRetry]) if (timer !== undefined) clearTimeout(timer);
            outputRetry = drainRetry = controlRetry = undefined;
            if (sampleRate !== undefined) {
                try { collectNativeStats(stopRealtimePcm()); } catch { /* teardown remains observable */ }
            }
            sampleRate = undefined;
            stream = undefined;
            pausedStream = undefined;
        },
        release: () => {
            try { releaseVoiceAudio(); } catch { /* teardown remains observable */ }
        },
    };
    return playback;
}
