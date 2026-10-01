import { MAX_REALTIME_TEXT_BYTES, realtimeClient, type AudioPorts } from '@byokit/realtime';
import { webRtcPeer } from '@byokit/realtime/webrtc';
import { isVoiceServiceReady, releaseVoiceAudio, routeVoiceAudio, startVoiceService } from '@/../modules/voice-overlay';
import { refreshRealtimeStreamSnapshot } from '../infrastructure/realtimeStream';
import { createRealtimePlayback } from '@/playback';
import { reportEnergy, resetEnergy } from './audioEnergy';
import { captureVoiceStreamSnapshot, openVoiceStream } from './openVoiceStream';
import { realtimeAppController } from './realtimeAppControl';
import { acquireRealtimeCapture } from './vadStandby';

export type RealtimeStatus = 'connecting' | 'connected' | 'thinking' | 'speaking' | 'disconnected';

export interface RealtimeHandle {
    stop: (reason?: string) => void;
    setMuted: (muted: boolean) => void;
    /** Ask the backend provider to say something unprompted. */
    speak: (text: string) => void;
}

const SERVICE_READY_TIMEOUT_MS = 2_000;

/** A screen with many controls can describe itself past one frame; an oversized answer would end the call. */
function fitFrame(text: string): string {
    let fitted = text;
    while (new TextEncoder().encode(fitted).length > MAX_REALTIME_TEXT_BYTES) fitted = fitted.slice(0, Math.floor(fitted.length * 0.9));
    return fitted;
}

/** Android returns a deaf session unless the microphone service is foreground first. */
async function foregroundMicrophoneService(): Promise<void> {
    if (!startVoiceService()) throw new Error('Microphone foreground service could not start.');
    const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
    while (!isVoiceServiceReady()) {
        if (Date.now() >= deadline) throw new Error('Microphone foreground service was not ready before capture.');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * muxr's side of @byokit/realtime's phone client: the voice stream, native
 * playback, the VAD-aware recorder and the microphone service. The kit owns the
 * session, WebRTC, reconnects and speech queueing. The service is stopped by the
 * session state, which knows whether local VAD standby still needs it.
 */
export function startRealtimeSession(options: {
    target: { machineId: string; sessionId: string };
    onStatus: (status: RealtimeStatus, detail?: string) => void;
    onTurn: (role: 'user' | 'agent', text: string) => void;
    onActivity?: () => void;
}): RealtimeHandle {
    const { target } = options;
    const playback = createRealtimePlayback();
    // Pinned once: a machine switch mid-call can never move a reconnect elsewhere.
    let snapshot = captureVoiceStreamSnapshot(target.machineId);
    const audio: AudioPorts = {
        microphone: { acquire: foregroundMicrophoneService, release: () => {} },
        capture: async (rate, onData) => {
            const lease = acquireRealtimeCapture(rate, onData);
            try { await lease.ready; } catch (error) { lease.release(); throw error; }
            return { pending: lease.pending, release: async () => lease.release() };
        },
        player: playback,
        route: async () => {
            if (!routeVoiceAudio()) throw new Error('This device could not route realtime audio.');
        },
        unroute: async () => releaseVoiceAudio(),
    };
    const client = realtimeClient({
        open: async () => {
            const current = await refreshRealtimeStreamSnapshot(await snapshot);
            snapshot = Promise.resolve(current);
            return openVoiceStream({ sessionId: target.sessionId, snapshot: current });
        },
        audio,
        webrtc: webRtcPeer,
        preserveMediaOnReconnect: true,
        retryableClose: (reason) => reason === undefined || /(?:connection failed|disconnected|timed out|input failed)/i.test(reason),
        onStatus: (status, detail) => {
            if (status === 'disconnected') resetEnergy();
            options.onStatus(status, detail);
        },
        onTurn: options.onTurn,
        onActivity: options.onActivity,
        onLevel: reportEnergy,
        onStats: (stats) => {
            const output = playback.stats;
            console.info(`realtime_voice_stats mic_captured=${stats.micCaptured} mic_sent=${stats.micSent} mic_queued=${stats.micQueued} mic_dropped=${stats.micDropped} output_received=${output.received} output_queued=${output.queued} output_dropped=${output.dropped} output_cleared=${output.cleared} playback_clears=${output.playbackClears} playback_underruns=${output.playbackUnderruns} native_peak=${output.nativePeak} transport_reconnects=${stats.transportReconnects} provider_reconnects=${stats.providerReconnects}`);
        },
        onAppRequest: async (action, target) => {
            try {
                if (action === 'view') return { ok: true, text: fitFrame(await realtimeAppController.inspect()) };
                if (action === 'navigate') return { ok: true, text: fitFrame(await realtimeAppController.navigateTo(target!)) };
                return { ok: true, text: fitFrame(await realtimeAppController.activate(target!)) };
            } catch {
                return { ok: false, text: 'The app could not complete that semantic action.' };
            }
        },
    });
    return { stop: client.stop, setMuted: client.setMuted, speak: client.speak };
}
