import { realtimePcm16ByteLength, type RealtimeControlAction } from '@muxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import type { PlaybackAdmit, PlaybackBoundary, RealtimePlayback } from './realtimePlayback';

const MAX_OUTPUT_BYTES = 192_000;
const OUTPUT_LOW_WATER_BYTES = 48_000;
const RETRY_MS = 20;
/** Seconds of audio to keep scheduled ahead; bounds memory and resume lag. */
const SCHEDULE_AHEAD_SECONDS = 0.5;

type PlaybackControl = Extract<RealtimeControlAction, 'pause_output' | 'resume_output' | 'output_drained'>;
export type PlaybackSink = {
    send: (frame: { type: 'realtime.control'; action: PlaybackControl }) => boolean;
};
type BoundaryCallback = { generation: number; streamGeneration: number; kind: PlaybackBoundary; run: () => void };
type QueuedAudio = { type: 'audio'; bytes: Uint8Array; queued: boolean };
type FinishMarker = { type: 'finish'; token: number; started: boolean; streamGeneration: number; callbacks: BoundaryCallback[] };
type OutputItem = QueuedAudio | FinishMarker;

/** PCM16 mono bytes to Web Audio samples. Pure: unit-covered. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const out = new Float32Array(Math.floor(bytes.length / 2));
    for (let index = 0; index < out.length; index += 1) {
        out[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    return out;
}

/**
 * Web Audio PCM output for one voice call. Queue, backpressure, drain, and
 * stream-generation fencing mirror the native sink exactly; only the last
 * mile differs (scheduled AudioBuffers instead of the audio service).
 * Foreground-only by platform design: a suspended tab stops the clock the
 * drain detector reads, and playback resumes on return.
 */
export function createRealtimePlayback(): RealtimePlayback {
    let stopped = false;
    let stream: PlaybackSink | undefined;
    let pausedStream: PlaybackSink | undefined;
    let context: AudioContext | undefined;
    let sampleRate: number | undefined;
    let playingUntil = 0;
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
    const scheduled = new Set<AudioBufferSourceNode>();
    const stats = {
        received: 0,
        queued: 0,
        dropped: 0,
        cleared: 0,
        playbackClears: 0,
        playbackUnderruns: 0,
        nativePeak: 0,
    };

    const now = (): number => context?.currentTime ?? 0;
    const drained = (): boolean => context === undefined || playingUntil <= now();

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
    const scheduleChunk = (bytes: Uint8Array): void => {
        if (context === undefined || sampleRate === undefined) return;
        if (playingUntil < now()) stats.playbackUnderruns += 1;
        const buffer = context.createBuffer(1, Math.max(1, Math.floor(bytes.length / 2)), sampleRate);
        buffer.getChannelData(0).set(pcm16ToFloat32(bytes));
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const startAt = Math.max(now(), playingUntil);
        try {
            source.start(startAt);
        } catch {
            return;
        }
        scheduled.add(source);
        source.onended = () => {
            scheduled.delete(source);
        };
        playingUntil = startAt + buffer.duration;
    };
    const flushOutput = (generation = outputGeneration): void => {
        while (!stopped && generation === outputGeneration && outputQueue.length > 0) {
            const head = outputQueue[0];
            if (head === undefined) break;
            if (head.type === 'finish') {
                if (outputBytes <= OUTPUT_LOW_WATER_BYTES) {
                    outputPressured = false;
                    flushControl();
                }
                head.started = true;
                if (!drained()) {
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
            if (context === undefined || sampleRate === undefined) {
                scheduleOutputFlush(generation);
                return;
            }
            if (playingUntil - now() >= SCHEDULE_AHEAD_SECONDS) {
                if (!head.queued) {
                    head.queued = true;
                    stats.queued += 1;
                }
                outputPressured = true;
                flushControl();
                scheduleOutputFlush(generation);
                return;
            }
            scheduleChunk(head.bytes);
            outputQueue.shift();
            outputBytes -= head.bytes.length;
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
        stats.playbackClears += 1;
        outputQueue.length = 0;
        pendingCallbacks.length = 0;
        outputBytes = 0;
        outputNeedsFinish = false;
        outputPressured = false;
        for (const source of [...scheduled]) {
            try {
                source.stop();
            } catch {
                // Already ended during a racing clear.
            }
        }
        scheduled.clear();
        if (context !== undefined) playingUntil = now();
        flushControl();
    };
    const stopAll = (): void => {
        stopped = true;
        for (const timer of [outputRetry, drainRetry, controlRetry]) if (timer !== undefined) clearTimeout(timer);
        outputRetry = drainRetry = controlRetry = undefined;
        for (const source of [...scheduled]) {
            try {
                source.stop();
            } catch {
                // Teardown remains observable when sources already ended.
            }
        }
        scheduled.clear();
        const closing = context;
        context = undefined;
        sampleRate = undefined;
        stream = undefined;
        pausedStream = undefined;
        if (closing !== undefined && closing.state !== 'closed') {
            void closing.close().catch(() => undefined);
        }
    };
    /** Rate change without full teardown: scheduled audio belongs to the old rate. */
    const stopScheduledOnly = (): void => {
        for (const source of [...scheduled]) {
            try {
                source.stop();
            } catch {
                // Already ended during a racing rate change.
            }
        }
        scheduled.clear();
        const closing = context;
        context = undefined;
        sampleRate = undefined;
        if (closing !== undefined && closing.state !== 'closed') {
            void closing.close().catch(() => undefined);
        }
    };
    const playback: RealtimePlayback = {
        stats,
        ensure: (rate) => {
            if (sampleRate === rate && context !== undefined) return;
            if (typeof AudioContext === 'undefined') throw new Error('This browser cannot play realtime audio.');
            stopScheduledOnly();
            try {
                context = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
            } catch (cause) {
                context = undefined;
                throw cause instanceof Error ? cause : new Error(String(cause));
            }
            sampleRate = rate;
            playingUntil = 0;
            void context.resume().catch(() => undefined);
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
            let decoded: Uint8Array;
            try {
                realtimePcm16ByteLength(data);
                decoded = decodeBase64(data, 'base64');
            } catch {
                return 'malformed';
            }
            stats.received += 1;
            if (outputBytes + decoded.length > MAX_OUTPUT_BYTES) {
                stats.dropped += 1;
                return 'overflow';
            }
            outputQueue.push({ type: 'audio', bytes: decoded, queued: false });
            outputBytes += decoded.length;
            outputNeedsFinish = true;
            flushOutput();
            return 'ok';
        },
        clear,
        finish,
        afterDrain,
        stop: () => {
            stopAll();
        },
        release: () => {
            if (context !== undefined && context.state !== 'closed') {
                const closing = context;
                context = undefined;
                sampleRate = undefined;
                void closing.close().catch(() => undefined);
            }
        },
    };
    return playback;
}
