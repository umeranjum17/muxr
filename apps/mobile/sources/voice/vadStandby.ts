import { AppState } from 'react-native';
import LiveAudioStream from 'react-native-live-audio-stream';
import { REALTIME_INPUT_RATE } from '@muxr/contract';
import { chunkEnergy } from '@/realtime/audioEnergy';
import {
    releaseVoiceAudio,
    routeVoiceAudio,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';

const PRE_ROLL_CHUNKS = 20;
const TRIGGER_BUFFER_CHUNKS = 200;
export const VAD_STANDBY_MS = 30 * 60_000;

let active = false;
let startGeneration = 0;
let triggered = false;
let buffered: string[] = [];
let loudFrames = 0;
let noiseFloor = 0.02;
let wake: (() => void) | undefined;
let expires: ReturnType<typeof setTimeout> | undefined;
let expiresAt = 0;
let expiryCallback: (() => void) | undefined;

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
    const generation = ++startGeneration;
    await Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
    if (generation !== startGeneration || !startVoiceService()) return false;
    if (!routeVoiceAudio()) {
        stopVoiceService();
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
        if (generation !== startGeneration) {
            await Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
            stopVoiceService();
            releaseVoiceAudio();
            return false;
        }
        active = true;
        triggered = false;
        buffered = [];
        loudFrames = 0;
        noiseFloor = 0.02;
        LiveAudioStream.on('data', inspect);
        await LiveAudioStream.start();
        if (generation !== startGeneration) {
            stopVadStandby();
            return false;
        }
        resetExpiry(onExpire);
        return true;
    } catch {
        active = false;
        stopVoiceService();
        releaseVoiceAudio();
        return false;
    }
}

function inspect(data: string): void {
    if (!active) return;
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

/** Reuse the already-open recorder and drain speech captured while the provider connected. */
export function claimVadCapture(sampleRate: number, onData: (data: string) => void): string[] | null {
    if (!active || sampleRate !== REALTIME_INPUT_RATE) return null;
    active = false;
    wake = undefined;
    if (expires !== undefined) clearTimeout(expires);
    expires = undefined;
    expiresAt = 0;
    expiryCallback = undefined;
    LiveAudioStream.on('data', onData);
    const pending = buffered;
    buffered = [];
    return pending;
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
    startGeneration += 1;
}

export function stopVadStandby(): void {
    startGeneration += 1;
    if (!active) return;
    active = false;
    triggered = false;
    wake = undefined;
    buffered = [];
    if (expires !== undefined) clearTimeout(expires);
    expires = undefined;
    expiresAt = 0;
    expiryCallback = undefined;
    void Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
    stopVoiceService();
    releaseVoiceAudio();
}
