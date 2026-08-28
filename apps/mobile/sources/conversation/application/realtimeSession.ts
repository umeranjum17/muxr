import { realtimePcm16ByteLength, type RealtimeHostFrame } from '@muxr/contract';
import { reportEnergy, resetEnergy } from '../infrastructure/audioEnergy';
import {
    capturePluginStreamSnapshot, openPluginStream, refreshPluginStreamSnapshot, type PluginStream,
} from '@/plugins/openPluginStream';
import { acquireRealtimeCapture, type RealtimeCaptureLease } from './vadStandby';
import { createRealtimePlayback } from '@/playback';
import { sync } from '@/catalog/sync';

export type RealtimeStatus = 'connecting' | 'connected' | 'thinking' | 'speaking' | 'disconnected';

export interface RealtimeHandle {
    stop: (reason?: string) => void;
    setMuted: (muted: boolean) => void;
    /** Ask the backend provider to say something unprompted. */
    speak: (text: string) => void;
}

const MAX_MIC_BYTES = 96_000; // Two seconds of mono 24 kHz PCM16.
const RETRY_MS = 20;
type StablePluginStream = Omit<PluginStream, 'send'> & {
    send: (frame: Parameters<PluginStream['send']>[0]) => boolean;
    start: () => void;
};

/** Provider-blind native streaming speech-to-speech transport. */
export function startRealtimeSession(options: {
    target: { machineId: string; sessionId: string };
    onStatus: (status: RealtimeStatus, detail?: string) => void;
    onTurn: (role: 'user' | 'agent', text: string) => void;
    onActivity?: () => void;
}): RealtimeHandle {
    const { target, onStatus, onTurn, onActivity } = options;
    const playback = createRealtimePlayback();
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
    let statsLogged = false;
    let speechBoundaryScheduled = false;
    const micQueue: Array<{ data: string; bytes: number; queued: boolean }> = [];
    let micBytes = 0;
    const stats = { micCaptured: 0, micSent: 0, micQueued: 0, micDropped: 0, transportReconnects: 0, providerReconnects: 0 };
    const STABLE_AFTER_MS = 30_000;

    const logStats = (): void => {
        if (statsLogged) return;
        statsLogged = true;
        const output = playback.stats;
        console.info(`realtime_voice_stats mic_captured=${stats.micCaptured} mic_sent=${stats.micSent} mic_queued=${stats.micQueued} mic_dropped=${stats.micDropped} output_received=${output.received} output_queued=${output.queued} output_dropped=${output.dropped} output_cleared=${output.cleared} playback_clears=${output.playbackClears} playback_underruns=${output.playbackUnderruns} native_peak=${output.nativePeak} transport_reconnects=${stats.transportReconnects} provider_reconnects=${stats.providerReconnects}`);
    };
    const stopCapture = (): void => {
        microphoneStarted = false;
        captureLease?.release();
        captureLease = undefined;
    };
    const teardown = (): void => {
        for (const timer of [reconnectTimer, stableTimer, micRetry, speechRetry]) {
            if (timer !== undefined) clearTimeout(timer);
        }
        reconnectTimer = stableTimer = micRetry = speechRetry = undefined;
        stopCapture();
        playback.stop();
        playback.release();
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
        if (playback.afterDrain('speech', () => {
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
    const startAudio = (inputRate: number, outputRate: number): Promise<void> => {
        playback.ensure(outputRate);
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
            const handleRealtimeFrame = (frame: RealtimeHostFrame): void => {
                switch (frame.type) {
                    case 'realtime.ready': {
                        if (readySeen) stats.providerReconnects += 1;
                        readySeen = true;
                        void startAudio(frame.inputRate, frame.outputRate).then(() => {
                            if (stopped || stream !== next) return;
                            readyStream = next;
                            const readyDetail = reconnects === 0 ? undefined : 'Voice stream reconnected';
                            const notifyReady = () => {
                                if (!stopped && stream === next) onStatus('connected', readyDetail);
                            };
                            if (!playback.afterDrain('connected', notifyReady)) notifyReady();
                            if (stableTimer !== undefined) clearTimeout(stableTimer);
                            stableTimer = setTimeout(() => { reconnects = 0; }, STABLE_AFTER_MS);
                            flushMic();
                            flushPendingSpeech();
                        }).catch(fail);
                        return;
                    }
                    case 'realtime.audio': {
                        const admitted = playback.admit(frame.data);
                        if (admitted === 'malformed') {
                            fail(new Error('Realtime provider sent malformed audio.'));
                            return;
                        }
                        if (admitted === 'overflow') {
                            fail(new Error('Realtime playback buffer overflowed.'));
                            return;
                        }
                        reportEnergy('output', frame.data);
                        onStatus('speaking');
                        return;
                    }
                    case 'realtime.audio.clear':
                        playback.clear();
                        speechBoundaryScheduled = false;
                        flushPendingSpeech();
                        return;
                    case 'realtime.state':
                        if (frame.state === 'connected') {
                            const notifyConnected = () => {
                                if (!stopped && stream === next) onStatus('connected', frame.detail);
                            };
                            if (!playback.finish(notifyConnected)) notifyConnected();
                            return;
                        }
                        onStatus(frame.state, frame.detail);
                        return;
                    case 'realtime.transcript':
                        onTurn(frame.role, frame.text);
                        return;
                    default:
                        return;
                }
            };
            next.onClose((reason) => {
                if (stopped || stream !== next) return;
                stream = undefined;
                if (readyStream === next) readyStream = undefined;
                playback.unbind(next);
                playback.finish();
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
                handleRealtimeFrame(frame);
            });
            stream = next;
            playback.bind(next);
            next.start();
            flushMic();
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
