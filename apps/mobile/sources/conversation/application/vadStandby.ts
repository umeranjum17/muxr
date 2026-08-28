import { AppState } from 'react-native';
import LiveAudioStream from 'react-native-live-audio-stream';
import { REALTIME_INPUT_RATE, realtimePcm16ByteLength } from '@muxr/contract';
import { chunkEnergy } from '../infrastructure/audioEnergy';
import {
    releaseVoiceAudio,
    routeVoiceAudio,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';

const PRE_ROLL_CHUNKS = 20;
const TRIGGER_BUFFER_CHUNKS = 200;
export const VAD_STANDBY_MS = 30 * 60_000;

type CaptureOwner = { id: number; kind: 'vad' | 'realtime' };
export interface RealtimeCaptureLease {
    pending: string[];
    ready: Promise<void>;
    release: () => void;
}

let ownerSequence = 0;
let owner: CaptureOwner | undefined;
let transitions = Promise.resolve<unknown>(undefined);
let active = false;
let triggered = false;
let buffered: string[] = [];
let loudFrames = 0;
let noiseFloor = 0.02;
let wake: (() => void) | undefined;
let expires: ReturnType<typeof setTimeout> | undefined;
let expiresAt = 0;
let expiryCallback: (() => void) | undefined;

const enqueue = <T>(transition: () => Promise<T>): Promise<T> => {
    const result = transitions.then(transition, transition);
    transitions = result.catch(() => undefined);
    return result;
};
const isOwner = (candidate: CaptureOwner): boolean => owner?.id === candidate.id;
const stopRecorder = async (): Promise<void> => {
    await Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
};
const clearVadState = (): void => {
    active = false;
    triggered = false;
    wake = undefined;
    buffered = [];
    if (expires !== undefined) clearTimeout(expires);
    expires = undefined;
    expiresAt = 0;
    expiryCallback = undefined;
};

function expireVadStandby(): void {
    const callback = expiryCallback;
    stopVadStandby();
    callback?.();
}

function resetExpiry(onExpire: () => void): void {
    if (expires !== undefined) clearTimeout(expires);
    expiresAt = Date.now() + VAD_STANDBY_MS;
    expiryCallback = onExpire;
    expires = setTimeout(expireVadStandby, VAD_STANDBY_MS);
}

AppState.addEventListener('change', (state) => {
    if (state === 'active' && active && Date.now() >= expiresAt) expireVadStandby();
});

/** Explicit, bounded local standby. No audio leaves the phone before speech wins the gate. */
export async function startVadStandby(onWake: () => void, onExpire: () => void): Promise<boolean> {
    wake = onWake;
    if (active) return true;
    const candidate: CaptureOwner = { id: ++ownerSequence, kind: 'vad' };
    owner = candidate;
    return enqueue(async () => {
        if (!isOwner(candidate)) return false;
        await stopRecorder();
        if (!isOwner(candidate)) return false;
        if (!startVoiceService()) {
            owner = undefined;
            clearVadState();
            return false;
        }
        if (!routeVoiceAudio()) {
            if (isOwner(candidate)) {
                owner = undefined;
                clearVadState();
                stopVoiceService();
                releaseVoiceAudio();
            }
            return false;
        }
        try {
            await LiveAudioStream.init({
                sampleRate: REALTIME_INPUT_RATE,
                channels: 1,
                bitsPerSample: 16,
                audioSource: 7,
                bufferSize: 4_800,
                wavFile: '',
            });
            if (!isOwner(candidate)) {
                await stopRecorder();
                if (owner === undefined) { stopVoiceService(); releaseVoiceAudio(); }
                return false;
            }
            active = true;
            triggered = false;
            buffered = [];
            loudFrames = 0;
            noiseFloor = 0.02;
            LiveAudioStream.on('data', inspect);
            await LiveAudioStream.start();
            if (!isOwner(candidate)) {
                await stopRecorder();
                if (owner === undefined) { stopVoiceService(); releaseVoiceAudio(); }
                return false;
            }
            resetExpiry(onExpire);
            return true;
        } catch {
            if (isOwner(candidate)) {
                owner = undefined;
                clearVadState();
                await stopRecorder();
                stopVoiceService();
                releaseVoiceAudio();
            }
            return false;
        }
    });
}

function inspect(data: string): void {
    if (!active) return;
    try { realtimePcm16ByteLength(data); } catch { return; }
    buffered.push(data);
    const limit = triggered ? TRIGGER_BUFFER_CHUNKS : PRE_ROLL_CHUNKS;
    if (buffered.length > limit) buffered.splice(0, buffered.length - limit);
    if (triggered) return;

    const energy = chunkEnergy(data);
    const threshold = Math.max(0.055, noiseFloor * 2.8);
    if (energy >= threshold) {
        loudFrames += 1;
    } else {
        loudFrames = 0;
        noiseFloor = noiseFloor * 0.95 + energy * 0.05;
    }
    if (loudFrames < 2) return;
    triggered = true;
    wake?.();
}

/** Reuse an armed VAD recorder, or serialize opening a realtime-owned recorder. */
export function acquireRealtimeCapture(sampleRate: number, onData: (data: string) => void): RealtimeCaptureLease {
    const candidate: CaptureOwner = { id: ++ownerSequence, kind: 'realtime' };
    const claimed = active && owner?.kind === 'vad' && sampleRate === REALTIME_INPUT_RATE;
    const pending = claimed ? buffered : [];
    owner = candidate;
    clearVadState();
    if (claimed) LiveAudioStream.on('data', onData);

    const ready = claimed ? Promise.resolve() : enqueue(async () => {
        if (!isOwner(candidate)) return;
        await stopRecorder();
        if (!isOwner(candidate)) return;
        if (!routeVoiceAudio()) throw new Error('This device could not route realtime audio.');
        await LiveAudioStream.init({ sampleRate, channels: 1, bitsPerSample: 16, audioSource: 7, bufferSize: 4_800, wavFile: '' });
        if (!isOwner(candidate)) { await stopRecorder(); return; }
        LiveAudioStream.on('data', onData);
        await LiveAudioStream.start();
        if (!isOwner(candidate)) await stopRecorder();
    });
    return {
        pending,
        ready,
        release: () => {
            if (!isOwner(candidate)) return;
            owner = undefined;
            void enqueue(async () => {
                if (owner === undefined) await stopRecorder();
            });
        },
    };
}

/** A provider/configuration failure leaves the local recorder alive; listen again. */
export function rearmVadStandby(): void {
    if (!active) return;
    triggered = false;
    loudFrames = 0;
    if (buffered.length > PRE_ROLL_CHUNKS) buffered = buffered.slice(-PRE_ROLL_CHUNKS);
}

export function vadStandbyOwnsMicrophone(): boolean {
    return active;
}

export function cancelVadStandbyStart(): void {
    if (owner?.kind !== 'vad' || active) return;
    owner = undefined;
    clearVadState();
}

export function stopVadStandby(): void {
    if (owner?.kind !== 'vad') return;
    owner = undefined;
    clearVadState();
    void enqueue(async () => {
        if (owner === undefined) {
            await stopRecorder();
            stopVoiceService();
            releaseVoiceAudio();
        }
    });
}
