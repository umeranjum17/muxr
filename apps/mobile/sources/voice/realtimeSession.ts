import LiveAudioStream from 'react-native-live-audio-stream';
import { reportEnergy, resetEnergy } from '@/realtime/audioEnergy';
import {
    clearRealtimePcm,
    playRealtimePcm,
    releaseVoiceAudio,
    routeVoiceAudio,
    startRealtimePcm,
    stopRealtimePcm,
} from '@/../modules/voice-overlay';
import {
    capturePluginStreamSnapshot,
    openPluginStream,
    refreshPluginStreamSnapshot,
    type PluginStream,
} from '@/plugins/openPluginStream';
import { claimVadCapture } from '@/voice/vadStandby';
import { sync } from '@/sync/sync';

export type RealtimeStatus = 'connecting' | 'connected' | 'thinking' | 'speaking' | 'disconnected';

export interface RealtimeHandle {
    stop: (reason?: string) => void;
    setMuted: (muted: boolean) => void;
    /** Ask the backend provider to say something unprompted. */
    speak: (text: string) => void;
}

/**
 * One provider-blind realtime transport. The app sends generic PCM/control
 * frames to the host plugin and renders the generic frames it gets back; auth,
 * model selection, prompts, tools and provider event names never leave the host.
 */
export function startRealtimeSession(options: {
    target: { machineId: string; sessionId: string };
    onStatus: (status: RealtimeStatus, detail?: string) => void;
    onTurn: (role: 'user' | 'agent', text: string) => void;
    onActivity?: () => void;
}): RealtimeHandle {
    const { target, onStatus, onTurn, onActivity } = options;
    let streamSnapshot = capturePluginStreamSnapshot('voice.session', target.machineId);
    let stream: PluginStream | undefined;
    let stopped = false;
    let muted = false;
    let microphoneStarted = false;
    let pendingSpeech: string | undefined;
    let reconnects = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    /** A stream that stays connected this long was healthy; forget its retries. */
    const STABLE_AFTER_MS = 30_000;

    const stopCapture = (): void => {
        if (!microphoneStarted) return;
        microphoneStarted = false;
        void Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
    };
    const teardown = (): void => {
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        if (stableTimer !== undefined) clearTimeout(stableTimer);
        stableTimer = undefined;
        stopCapture();
        stopRealtimePcm();
        releaseVoiceAudio();
        const current = stream;
        stream = undefined;
        current?.close();
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
    const retryableClose = (reason?: string): boolean => reason === undefined
        || /(?:connection failed|disconnected|timed out|input failed)/i.test(reason);

    function restartPlayback(outputRate: number): void {
        stopRealtimePcm();
        if (!routeVoiceAudio() || !startRealtimePcm(outputRate)) throw new Error('This device could not start realtime audio.');
    }
    async function startAudio(inputRate: number, outputRate: number): Promise<void> {
        if (!routeVoiceAudio() || !startRealtimePcm(outputRate)) throw new Error('This device could not start realtime audio.');
        const onData = (data: string) => {
            if (!stopped && !muted) {
                reportEnergy('input', data);
                stream?.send({ type: 'realtime.audio', data });
                // The user speaking is activity; without this the idle timer
                // hangs up mid-sentence when the provider stays quiet.
                onActivity?.();
            }
        };
        const pending = claimVadCapture(inputRate, onData);
        if (pending !== null) {
            microphoneStarted = true;
            for (const data of pending) onData(data);
            return;
        }
        await LiveAudioStream.init({
            sampleRate: inputRate,
            channels: 1,
            bitsPerSample: 16,
            audioSource: 7,
            bufferSize: 4_800,
            wavFile: '',
        });
        LiveAudioStream.on('data', onData);
        await LiveAudioStream.start();
        if (stopped) stopCapture();
        else {
            if (!routeVoiceAudio()) throw new Error('This device could not route realtime audio.');
            microphoneStarted = true;
        }
    }

    const connect = async (): Promise<void> => {
        onStatus('connecting', reconnects === 0 ? undefined : 'Reconnecting voice stream');
        try {
            const snapshot = await refreshPluginStreamSnapshot(await streamSnapshot);
            streamSnapshot = Promise.resolve(snapshot);
            const next = await openPluginStream('voice.session', {
                sessionId: target.sessionId,
                snapshot,
                requestControl: (params) => sync.request('plugin.stream', params),
            });
            if (stopped) {
                next.close();
                return;
            }
            stream = next;
            next.onClose((reason) => {
                if (stopped || stream !== next) return;
                stream = undefined;
                clearRealtimePcm();
                if (stableTimer !== undefined) { clearTimeout(stableTimer); stableTimer = undefined; }
                if (microphoneStarted && reconnects < 2 && retryableClose(reason)) {
                    reconnects += 1;
                    reconnectTimer = setTimeout(() => { void connect(); }, reconnects * 500);
                } else stop(reason);
            });
            next.onFrame((frame) => {
                if (stopped || stream !== next) return;
                onActivity?.();
                if (frame.type === 'realtime.ready') {
                    const ready = microphoneStarted
                        ? Promise.resolve().then(() => restartPlayback(frame.outputRate))
                        : startAudio(frame.inputRate, frame.outputRate);
                    void ready.then(() => {
                        if (stopped || stream !== next) return;
                        onStatus('connected', reconnects === 0 ? undefined : 'Voice stream reconnected');
                        // Reconnect budget is consecutive, not cumulative: after a
                        // stable stretch the next drop gets the full budget again.
                        if (stableTimer !== undefined) clearTimeout(stableTimer);
                        stableTimer = setTimeout(() => { reconnects = 0; }, STABLE_AFTER_MS);
                        if (pendingSpeech !== undefined) {
                            next.send({ type: 'realtime.say', text: pendingSpeech });
                            pendingSpeech = undefined;
                        }
                    }).catch(fail);
                } else if (frame.type === 'realtime.audio') {
                    reportEnergy('output', frame.data);
                    playRealtimePcm(frame.data);
                    onStatus('speaking');
                } else if (frame.type === 'realtime.audio.clear') {
                    clearRealtimePcm();
                } else if (frame.type === 'realtime.state') {
                    onStatus(frame.state, frame.detail);
                } else if (frame.type === 'realtime.transcript') {
                    onTurn(frame.role, frame.text);
                }
            });
        } catch (error) {
            fail(error);
        }
    };
    void connect();

    return {
        stop,
        setMuted: (nextMuted) => {
            muted = nextMuted;
            try { stream?.send({ type: 'realtime.control', action: muted ? 'mute' : 'unmute' }); } catch { /* local mute is already applied */ }
        },
        speak: (text) => {
            const clean = text.trim();
            if (clean === '') return;
            if (stream === undefined || !microphoneStarted) pendingSpeech = clean;
            else stream.send({ type: 'realtime.say', text: clean });
        },
    };
}
