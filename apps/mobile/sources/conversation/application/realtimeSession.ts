import { MAX_REALTIME_TEXT_BYTES, realtimeClient, type AudioPorts } from '@byokit/realtime';
import { webRtcPeer } from '@byokit/realtime/webrtc';
import { REALTIME_OUTPUT_RATE, REALTIME_PLANNING_DETAIL } from '@trymuxr/contract';
import { encodeBase64 } from '@/encryption/base64';
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

export interface RealtimeCallbacks {
    onStatus: (status: RealtimeStatus, detail?: string) => void;
    onTurn: (role: 'user' | 'agent', text: string) => void;
    onActivity?: () => void;
}

/**
 * A call connected before anyone talks: credential, signaling and WebRTC, but
 * no microphone, no microphone service, no device audio route and no turn.
 */
export interface PreconnectedRealtimeSession {
    stop: () => void;
    /** The first talk: route the audio, open the microphone and hand the call over. Throws when the audio cannot be routed. */
    talk: (callbacks: RealtimeCallbacks) => RealtimeHandle;
}

const SERVICE_READY_TIMEOUT_MS = 2_000;

/** A screen with many controls can describe itself past one frame; an oversized answer would end the call. */
function fitFrame(text: string): string {
    let fitted = text;
    while (new TextEncoder().encode(fitted).length > MAX_REALTIME_TEXT_BYTES) fitted = fitted.slice(0, Math.floor(fitted.length * 0.9));
    return fitted;
}

let planningTone: string | undefined;

/**
 * Two soft rising notes, ~160 ms of PCM16 at the output rate: heard as "working
 * on it", not as speech. Trailing silence pads it to 600 ms: the native
 * streaming track only starts once its buffer fills, so a bare 160 ms clip
 * would never play.
 */
function planningToneAudio(): string {
    if (planningTone !== undefined) return planningTone;
    const noteSamples = Math.round(REALTIME_OUTPUT_RATE * 0.08);
    const samples = new Int16Array(Math.round(REALTIME_OUTPUT_RATE * 0.6));
    [660, 880].forEach((hz, note) => {
        for (let i = 0; i < noteSamples; i++) {
            const envelope = Math.sin(Math.PI * i / noteSamples);
            samples[note * noteSamples + i] = Math.round(0.2 * 32767 * envelope * Math.sin(2 * Math.PI * hz * i / REALTIME_OUTPUT_RATE));
        }
    });
    planningTone = encodeBase64(new Uint8Array(samples.buffer));
    return planningTone;
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
export function startRealtimeSession(options: RealtimeCallbacks & { target: { machineId: string; sessionId: string } }): RealtimeHandle {
    return openRealtimeCall(options.target, options, false).handle;
}

/** Connect ahead of the first talk. Only WebRTC providers negotiate without a microphone. */
export function preconnectRealtimeSession(options: {
    target: { machineId: string; sessionId: string };
    onEnded: () => void;
}): PreconnectedRealtimeSession {
    const call = openRealtimeCall(options.target, {
        onStatus: (status) => { if (status === 'disconnected') options.onEnded(); },
        onTurn: () => {},
    }, true);
    return { stop: () => call.handle.stop(), talk: call.talk };
}

function openRealtimeCall(
    target: { machineId: string; sessionId: string },
    initial: RealtimeCallbacks,
    preconnect: boolean,
): { handle: RealtimeHandle; talk: (callbacks: RealtimeCallbacks) => RealtimeHandle } {
    let callbacks = initial;
    let talking = !preconnect;
    let routed = false;
    let last: [RealtimeStatus, string | undefined] = ['connecting', undefined];
    const playback = createRealtimePlayback();
    // Pinned once: a machine switch mid-call can never move a reconnect elsewhere.
    let snapshot = captureVoiceStreamSnapshot(target.machineId);
    const notTalking = () => Promise.reject(new Error('Voice has no microphone before the first talk.'));
    const route = () => {
        if (!routeVoiceAudio()) throw new Error('This device could not route realtime audio.');
        routed = true;
    };
    const audio: AudioPorts = {
        microphone: { acquire: () => talking ? foregroundMicrophoneService() : notTalking(), release: () => {} },
        capture: async (rate, onData) => {
            if (!talking) return notTalking();
            const lease = acquireRealtimeCapture(rate, onData);
            try { await lease.ready; } catch (error) { lease.release(); throw error; }
            return { pending: lease.pending, release: async () => lease.release() };
        },
        // The route puts the whole device into call audio, so a call that
        // nobody has talked on yet leaves it alone, closing included.
        player: { ...playback, release: () => { if (talking) playback.release(); } },
        route: async () => { if (talking) route(); },
        unroute: async () => {
            if (!routed) return;
            routed = false;
            releaseVoiceAudio();
        },
    };
    // A lazy call negotiates with no microphone; each fresh peer, including
    // one a reconnect makes, gets it once it is connected, and only then is
    // the call listening.
    const attachMicrophone = (then: () => void) => {
        client.attachMic().then(then, (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            // A reconnect or stop raced the attach; it owns the outcome, and a new peer attaches again.
            if (reason !== 'Voice media is unavailable.' && reason !== 'Voice is closed.') client.stop(reason);
        });
    };
    // Dropped when a newer status overtook it while the microphone attached.
    const forward = (status: RealtimeStatus, detail: string | undefined) => {
        if (last[0] === status && last[1] === detail) callbacks.onStatus(status, detail);
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
        ...(preconnect ? { capture: 'lazy' as const } : {}),
        onStatus: (status, detail) => {
            last = [status, detail];
            if (status === 'disconnected') resetEnergy();
            // A planner request takes seconds; the tone fills the silence. Codex
            // speaks over WebRTC, so the PCM player is otherwise idle.
            if (status === 'thinking' && detail === REALTIME_PLANNING_DETAIL) {
                try {
                    playback.ensure(REALTIME_OUTPUT_RATE);
                    if (playback.admit(planningToneAudio()) === 'ok') playback.finish();
                } catch { /* a missing cue never ends the call */ }
            }
            if (preconnect && talking && status === 'connected') attachMicrophone(() => forward(status, detail));
            else callbacks.onStatus(status, detail);
        },
        onTurn: (role, text) => callbacks.onTurn(role, text),
        onActivity: () => callbacks.onActivity?.(),
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
    const handle: RealtimeHandle = { stop: client.stop, setMuted: client.setMuted, speak: client.speak };
    const talk = (next: RealtimeCallbacks): RealtimeHandle => {
        callbacks = next;
        talking = true;
        try {
            route();
        } catch (error) {
            client.stop(error instanceof Error ? error.message : String(error));
            throw error;
        }
        // Replayed once the caller holds the handle the status belongs to,
        // and a live call only once its microphone is attached.
        const [status, detail] = last;
        const replay = () => { if (callbacks === next) forward(status, detail); };
        if (status === 'connected' || status === 'thinking' || status === 'speaking') attachMicrophone(replay);
        else queueMicrotask(replay);
        return handle;
    };
    return { handle, talk };
}
