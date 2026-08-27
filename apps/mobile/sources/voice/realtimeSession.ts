import { realtimePcm16ByteLength } from '@muxr/contract';
import { reportEnergy, resetEnergy } from '@/realtime/audioEnergy';
import {
    clearRealtimePcm, finishRealtimePcm, isRealtimePcmDrained, playRealtimePcm, releaseVoiceAudio,
    routeVoiceAudio, startRealtimePcm, stopRealtimePcm,
} from '@/../modules/voice-overlay';
import {
    capturePluginStreamSnapshot, openPluginStream, refreshPluginStreamSnapshot, type PluginStream,
} from '@/plugins/openPluginStream';
import { acquireRealtimeCapture, type RealtimeCaptureLease } from '@/voice/vadStandby';
import { sync } from '@/sync/sync';

export type RealtimeStatus = 'connecting' | 'connected' | 'thinking' | 'speaking' | 'disconnected';

export interface RealtimeHandle {
    stop: (reason?: string) => void;
    setMuted: (muted: boolean) => void;
    /** Ask the backend provider to say something unprompted. */
    speak: (text: string) => void;
}

const MAX_MIC_BYTES = 96_000; // Two seconds of mono 24 kHz PCM16.
const MAX_OUTPUT_BYTES = 192_000;
const OUTPUT_LOW_WATER_BYTES = 48_000;
const RETRY_MS = 20;
type StablePluginStream = Omit<PluginStream, 'send'> & {
    send: (frame: Parameters<PluginStream['send']>[0]) => boolean;
    start: () => void;
};
type BoundaryCallback = { generation: number; kind: 'connected' | 'speech'; run: () => void };
type OutputItem =
    | { type: 'audio'; data: string; bytes: number; queued: boolean }
    | { type: 'finish'; token: number; started: boolean; callbacks: BoundaryCallback[] };

/** Provider-blind native streaming speech-to-speech transport. */
export function startRealtimeSession(options: {
    target: { machineId: string; sessionId: string };
    onStatus: (status: RealtimeStatus, detail?: string) => void;
    onTurn: (role: 'user' | 'agent', text: string) => void;
    onActivity?: () => void;
}): RealtimeHandle {
    const { target, onStatus, onTurn, onActivity } = options;
    let streamSnapshot = capturePluginStreamSnapshot('voice.session', target.machineId);
    let stream: StablePluginStream | undefined;
    let readyStream: StablePluginStream | undefined;
    let stopped = false;
    let muted = false;
    let microphoneStarted = false;
    let captureLease: RealtimeCaptureLease | undefined;
    let captureStart: Promise<void> | undefined;
    const pendingSpeech: string[] = [];
    let reconnects = 0;
    let connectFlight: Promise<void> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let micRetry: ReturnType<typeof setTimeout> | undefined;
    let speechRetry: ReturnType<typeof setTimeout> | undefined;
    let outputRetry: ReturnType<typeof setTimeout> | undefined;
    let outputControlRetry: ReturnType<typeof setTimeout> | undefined;
    let outputDrainRetry: ReturnType<typeof setTimeout> | undefined;
    let outputGeneration = 0;
    let finishSequence = 0;
    let outputNeedsFinish = false;
    let outputPressured = false;
    let pausedStream: StablePluginStream | undefined;
    let playbackRate: number | undefined;
    let statsLogged = false;
    let speechBoundaryScheduled = false;
    const micQueue: Array<{ data: string; bytes: number; queued: boolean }> = [];
    const outputQueue: OutputItem[] = [];
    const pendingBoundaryCallbacks: BoundaryCallback[] = [];
    let micBytes = 0;
    let outputBytes = 0;
    const stats = {
        micCaptured: 0, micSent: 0, micQueued: 0, micDropped: 0,
        outputReceived: 0, outputQueued: 0, outputDropped: 0, outputCleared: 0,
        playbackClears: 0, playbackUnderruns: 0, nativePeak: 0,
        transportReconnects: 0, providerReconnects: 0,
    };
    const STABLE_AFTER_MS = 30_000;

    const collectNativeStats = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        const native = value as Record<string, unknown>;
        const number = (name: string): number => typeof native[name] === 'number' && Number.isFinite(native[name]) ? native[name] as number : 0;
        stats.playbackUnderruns += number('underruns');
        stats.playbackClears += number('clears');
        stats.nativePeak = Math.max(stats.nativePeak, number('peakQueuedMs'), number('peakQueuedBytes'), number('peak'));
    };
    const stopPlayer = (): void => {
        try { collectNativeStats(stopRealtimePcm()); } catch { /* teardown remains observable */ }
    };
    const logStats = (): void => {
        if (statsLogged) return;
        statsLogged = true;
        console.info(`realtime_voice_stats mic_captured=${stats.micCaptured} mic_sent=${stats.micSent} mic_queued=${stats.micQueued} mic_dropped=${stats.micDropped} output_received=${stats.outputReceived} output_queued=${stats.outputQueued} output_dropped=${stats.outputDropped} output_cleared=${stats.outputCleared} playback_clears=${stats.playbackClears} playback_underruns=${stats.playbackUnderruns} native_peak=${stats.nativePeak} transport_reconnects=${stats.transportReconnects} provider_reconnects=${stats.providerReconnects}`);
    };
    const stopCapture = (): void => {
        microphoneStarted = false;
        captureLease?.release();
        captureLease = undefined;
    };
    const teardown = (): void => {
        for (const timer of [reconnectTimer, stableTimer, micRetry, speechRetry, outputRetry, outputControlRetry, outputDrainRetry]) {
            if (timer !== undefined) clearTimeout(timer);
        }
        reconnectTimer = stableTimer = micRetry = speechRetry = outputRetry = outputControlRetry = outputDrainRetry = undefined;
        stopCapture();
        if (playbackRate !== undefined) stopPlayer();
        playbackRate = undefined;
        try { releaseVoiceAudio(); } catch { /* teardown remains observable */ }
        const current = stream;
        stream = undefined;
        readyStream = undefined;
        try { current?.close(); } catch { /* stats still emit exactly once */ }
        logStats();
    };
    const stop = (reason?: string): void => {
        if (stopped) return;
        stopped = true;
        resetEnergy();
        try { stream?.send({ type: 'realtime.control', action: 'stop' }); } catch { /* closing anyway */ }
        teardown();
        onStatus('disconnected', reason);
    };
    const fail = (error: unknown): void => stop(error instanceof Error ? error.message : String(error));
    const retryableClose = (reason?: string): boolean => reason === undefined || /(?:connection failed|disconnected|timed out|input failed)/i.test(reason);

    const scheduleMicFlush = (): void => {
        if (stopped || micRetry !== undefined) return;
        micRetry = setTimeout(() => { micRetry = undefined; flushMic(); }, RETRY_MS);
    };
    const flushMic = (): void => {
        while (!stopped && stream !== undefined && micQueue.length > 0) {
            const head = micQueue[0];
            let sent = false;
            try { sent = stream.send({ type: 'realtime.audio', data: head.data }); } catch { /* retry */ }
            if (!sent) {
                if (!head.queued) { head.queued = true; stats.micQueued += 1; }
                scheduleMicFlush();
                return;
            }
            micQueue.shift();
            micBytes -= head.bytes;
            stats.micSent += 1;
        }
        if (micQueue.length > 0) {
            const head = micQueue[0];
            if (!head.queued) { head.queued = true; stats.micQueued += 1; }
            scheduleMicFlush();
        }
    };
    const captureFrame = (data: string): void => {
        if (stopped) return;
        let bytes: number;
        try { bytes = realtimePcm16ByteLength(data); } catch {
            fail(new Error('Realtime microphone received malformed audio.'));
            return;
        }
        if (muted) return;
        stats.micCaptured += 1;
        reportEnergy('input', data);
        onActivity?.();
        if (micBytes + bytes > MAX_MIC_BYTES) {
            stats.micDropped += 1;
            fail(new Error('Realtime microphone buffer overflowed.'));
            return;
        }
        micQueue.push({ data, bytes, queued: false });
        micBytes += bytes;
        flushMic();
    };

    const scheduleOutputControl = (): void => {
        if (stopped || outputControlRetry !== undefined) return;
        outputControlRetry = setTimeout(() => {
            outputControlRetry = undefined;
            flushOutputControl();
        }, RETRY_MS);
    };
    const flushOutputControl = (): void => {
        if (stopped || stream === undefined) {
            if (outputPressured) scheduleOutputControl();
            return;
        }
        const action = outputPressured
            ? pausedStream === stream ? undefined : 'pause_output'
            : pausedStream === stream ? 'resume_output' : undefined;
        if (action === undefined) return;
        let sent = false;
        try { sent = stream.send({ type: 'realtime.control', action }); } catch { /* retry */ }
        if (!sent) { scheduleOutputControl(); return; }
        pausedStream = action === 'pause_output' ? stream : undefined;
    };
    const setOutputPressured = (pressured: boolean): void => {
        outputPressured = pressured;
        flushOutputControl();
    };
    const clearOutput = (): void => {
        outputGeneration += 1;
        for (const timer of [outputRetry, outputDrainRetry, outputControlRetry]) if (timer !== undefined) clearTimeout(timer);
        outputRetry = outputDrainRetry = outputControlRetry = undefined;
        stats.outputCleared += outputQueue.filter((item) => item.type === 'audio').length;
        outputQueue.length = 0;
        pendingBoundaryCallbacks.length = 0;
        outputBytes = 0;
        outputNeedsFinish = false;
        speechBoundaryScheduled = false;
        setOutputPressured(false);
        if (playbackRate !== undefined) {
            clearRealtimePcm();
        }
        flushPendingSpeech();
    };
    const scheduleOutputFlush = (generation: number): void => {
        if (stopped || outputRetry !== undefined) return;
        outputRetry = setTimeout(() => {
            outputRetry = undefined;
            if (generation === outputGeneration) flushOutput(generation);
        }, RETRY_MS);
    };
    const flushOutput = (generation = outputGeneration): void => {
        while (!stopped && generation === outputGeneration && outputQueue.length > 0) {
            const head = outputQueue[0];
            if (head.type === 'finish') {
                if (outputBytes <= OUTPUT_LOW_WATER_BYTES) setOutputPressured(false);
                if (!head.started && !finishRealtimePcm()) {
                    scheduleOutputFlush(generation);
                    return;
                }
                head.started = true;
                if (!isRealtimePcmDrained()) {
                    if (outputDrainRetry === undefined) {
                        const token = head.token;
                        outputDrainRetry = setTimeout(() => {
                            outputDrainRetry = undefined;
                            const current = outputQueue[0];
                            if (generation === outputGeneration && current?.type === 'finish' && current.token === token) flushOutput(generation);
                        }, RETRY_MS);
                    }
                    return;
                }
                let acknowledged = false;
                try { acknowledged = stream?.send({ type: 'realtime.control', action: 'output_drained' }) ?? false; } catch { /* retry */ }
                if (!acknowledged) { scheduleOutputFlush(generation); return; }
                outputQueue.shift();
                if (head.callbacks.length > 0) {
                    const nextFinish = outputQueue.find((item): item is Extract<OutputItem, { type: 'finish' }> => item.type === 'finish');
                    if (nextFinish !== undefined) {
                        nextFinish.callbacks.unshift(...head.callbacks);
                    } else if (outputQueue.length > 0) {
                        pendingBoundaryCallbacks.push(...head.callbacks);
                    } else {
                        const releasesSpeech = head.callbacks.some((callback) => callback.kind === 'speech');
                        for (const callback of head.callbacks) {
                            if (callback.generation === outputGeneration && !(releasesSpeech && callback.kind === 'connected')) callback.run();
                        }
                    }
                }
                continue;
            }
            if (!playRealtimePcm(head.data)) {
                if (!head.queued) { head.queued = true; stats.outputQueued += 1; }
                setOutputPressured(true);
                scheduleOutputFlush(generation);
                return;
            }
            outputQueue.shift();
            outputBytes -= head.bytes;
        }
        if (!stopped && generation === outputGeneration && outputQueue.length === 0 && outputBytes <= OUTPUT_LOW_WATER_BYTES) {
            setOutputPressured(false);
        }
    };
    const latestPendingFinish = (): Extract<OutputItem, { type: 'finish' }> | undefined => {
        for (let index = outputQueue.length - 1; index >= 0; index -= 1) {
            const item = outputQueue[index];
            if (item.type === 'finish') return item;
        }
        return undefined;
    };
    const deferUntilOutputBoundary = (kind: BoundaryCallback['kind'], callback: () => void): boolean => {
        const pending = { generation: outputGeneration, kind, run: callback };
        const marker = latestPendingFinish();
        if (marker !== undefined) {
            marker.callbacks.push(pending);
            return true;
        }
        if (!outputNeedsFinish) return false;
        pendingBoundaryCallbacks.push(pending);
        return true;
    };
    const finishOutput = (onDrained?: () => void): boolean => {
        if (stopped || playbackRate === undefined) return false;
        if (!outputNeedsFinish) return onDrained === undefined ? false : deferUntilOutputBoundary('connected', onDrained);
        outputNeedsFinish = false;
        const callbacks = pendingBoundaryCallbacks.splice(0);
        if (onDrained !== undefined) callbacks.push({ generation: outputGeneration, kind: 'connected', run: onDrained });
        outputQueue.push({ type: 'finish', token: ++finishSequence, started: false, callbacks });
        flushOutput();
        return onDrained !== undefined;
    };

    const scheduleSpeechFlush = (): void => {
        if (stopped || speechRetry !== undefined) return;
        speechRetry = setTimeout(() => {
            speechRetry = undefined;
            flushPendingSpeech();
        }, RETRY_MS);
    };
    const flushPendingSpeech = (): void => {
        if (stopped || pendingSpeech.length === 0 || stream === undefined || readyStream !== stream || !microphoneStarted) return;
        if (speechBoundaryScheduled) return;
        if (deferUntilOutputBoundary('speech', () => {
            speechBoundaryScheduled = false;
            flushPendingSpeech();
        })) {
            speechBoundaryScheduled = true;
            return;
        }
        while (!stopped && pendingSpeech.length > 0 && stream !== undefined && readyStream === stream) {
            let sent = false;
            try { sent = stream.send({ type: 'realtime.say', text: pendingSpeech[0] }); } catch { /* retry */ }
            if (!sent) {
                scheduleSpeechFlush();
                return;
            }
            pendingSpeech.shift();
        }
    };
    const queueOutput = (data: string): void => {
        let bytes: number;
        try { bytes = realtimePcm16ByteLength(data); } catch {
            fail(new Error('Realtime provider sent malformed audio.'));
            return;
        }
        stats.outputReceived += 1;
        if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
            stats.outputDropped += 1;
            fail(new Error('Realtime playback buffer overflowed.'));
            return;
        }
        outputQueue.push({ type: 'audio', data, bytes, queued: false });
        outputBytes += bytes;
        outputNeedsFinish = true;
        reportEnergy('output', data);
        flushOutput();
        onStatus('speaking');
    };

    function ensurePlayback(outputRate: number): void {
        if (playbackRate === outputRate) return;
        if (playbackRate !== undefined) stopPlayer();
        if (!routeVoiceAudio() || !startRealtimePcm(outputRate)) throw new Error('This device could not start realtime audio.');
        playbackRate = outputRate;
    }
    const startAudio = (inputRate: number, outputRate: number): Promise<void> => {
        ensurePlayback(outputRate);
        if (captureStart !== undefined) return captureStart;
        captureStart = (async () => {
            const lease = acquireRealtimeCapture(inputRate, captureFrame);
            captureLease = lease;
            for (const data of lease.pending) captureFrame(data);
            await lease.ready;
            if (stopped || captureLease !== lease) lease.release();
            else microphoneStarted = true;
        })();
        return captureStart;
    };

    const connect = (): Promise<void> => {
        if (connectFlight !== undefined) return connectFlight;
        connectFlight = (async () => {
            onStatus('connecting', reconnects === 0 ? undefined : 'Reconnecting voice stream');
            const snapshot = await refreshPluginStreamSnapshot(await streamSnapshot);
            streamSnapshot = Promise.resolve(snapshot);
            const next = await openPluginStream('voice.session', {
                sessionId: target.sessionId,
                snapshot,
                requestControl: (params) => sync.request('plugin.stream', params),
            }) as StablePluginStream;
            if (stopped) { next.close(); return; }
            let readySeen = false;
            next.onClose((reason) => {
                if (stopped || stream !== next) return;
                stream = undefined;
                if (readyStream === next) readyStream = undefined;
                if (pausedStream === next) pausedStream = undefined;
                finishOutput();
                if (stableTimer !== undefined) { clearTimeout(stableTimer); stableTimer = undefined; }
                if (microphoneStarted && reconnects < 2 && retryableClose(reason)) {
                    reconnects += 1;
                    stats.transportReconnects += 1;
                    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect().catch(fail); }, reconnects * 500);
                } else stop(reason);
            });
            next.onFrame((frame) => {
                if (stopped || stream !== next) return;
                onActivity?.();
                if (frame.type === 'realtime.ready') {
                    if (readySeen) stats.providerReconnects += 1;
                    readySeen = true;
                    const ready = startAudio(frame.inputRate, frame.outputRate);
                    void ready.then(() => {
                        if (stopped || stream !== next) return;
                        readyStream = next;
                        const readyDetail = reconnects === 0 ? undefined : 'Voice stream reconnected';
                        const notifyReady = () => {
                            if (!stopped && stream === next) {
                                onStatus('connected', readyDetail);
                            }
                        };
                        if (!deferUntilOutputBoundary('connected', notifyReady)) notifyReady();
                        if (stableTimer !== undefined) clearTimeout(stableTimer);
                        stableTimer = setTimeout(() => { reconnects = 0; }, STABLE_AFTER_MS);
                        flushMic();
                        flushPendingSpeech();
                    }).catch(fail);
                } else if (frame.type === 'realtime.audio') {
                    queueOutput(frame.data);
                } else if (frame.type === 'realtime.audio.clear') {
                    clearOutput();
                } else if (frame.type === 'realtime.state') {
                    if (frame.state === 'connected') {
                        const notifyConnected = () => {
                            if (!stopped && stream === next) onStatus('connected', frame.detail);
                        };
                        if (!finishOutput(notifyConnected)) notifyConnected();
                    } else onStatus(frame.state, frame.detail);
                } else if (frame.type === 'realtime.transcript') {
                    onTurn(frame.role, frame.text);
                }
            });
            stream = next;
            next.start();
            flushMic();
            flushOutputControl();
            flushOutput();
        })().finally(() => { connectFlight = undefined; });
        return connectFlight;
    };
    void connect().catch(fail);

    return {
        stop,
        setMuted: (nextMuted) => {
            muted = nextMuted;
            try { stream?.send({ type: 'realtime.control', action: muted ? 'mute' : 'unmute' }); } catch { /* local mute is already applied */ }
        },
        speak: (value) => {
            const clean = value.trim();
            if (clean === '') return;
            pendingSpeech.push(clean);
            flushPendingSpeech();
        },
    };
}
