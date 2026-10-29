import LiveAudioStream from 'react-native-live-audio-stream';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { VAD_RATE, type Vad } from '@byokit/audio';
import { REALTIME_INPUT_RATE, realtimePcm16ByteLength } from '@trymuxr/contract';
import { decodeBase64 } from '@/encryption/base64';
import { chunkEnergy } from './audioEnergy';
import {
    releaseVoiceAudio,
    routeVoiceAudio,
    setVoiceNetworkActive,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';

const PRE_ROLL_CHUNKS = 20;
const TRIGGER_BUFFER_CHUNKS = 200;
const bundledVadModel: number = require('@/assets/models/silero_vad_v5_1.onnx');

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
let kitVad: Vad | undefined;
let vadWork = Promise.resolve();
let resampleInputCount = 0;
let resampleOutputCount = 0;
let resampleCarry: number[] = [];

async function createKitVad(): Promise<Vad> {
    const [{ createVad }, { sileroSession }, runtime] = await Promise.all([
        import('@byokit/audio'),
        import('@byokit/audio/react-native'),
        import('onnxruntime-react-native'),
    ]);
    const asset = Asset.fromModule(bundledVadModel);
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('Bundled BYOKit VAD model unavailable.');
    const session = await sileroSession(
        await new File(asset.localUri).bytes(),
        runtime as unknown as import('@byokit/audio/react-native').OrtRuntime,
    );
    return createVad({ session });
}

async function releaseKitVad(): Promise<void> {
    const detector = kitVad;
    kitVad = undefined;
    await vadWork.catch(() => undefined);
    await detector?.release();
}

function pcm16(data: string): Int16Array {
    const bytes = decodeBase64(data);
    if (bytes.byteLength % 2 !== 0) throw new Error('Invalid PCM16 chunk.');
    const samples = new Int16Array(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
    return samples;
}

// ponytail: linear interpolation keeps the 24 kHz capture and VAD input in phase; add an anti-alias filter only if handset speech checks show misses.
function resampleToVadRate(samples: Int16Array): Int16Array {
    const start = resampleInputCount;
    const carryStart = start - resampleCarry.length;
    const combined = [...resampleCarry, ...samples];
    const end = start + samples.length;
    const output: number[] = [];
    while (true) {
        const position = resampleOutputCount * REALTIME_INPUT_RATE / VAD_RATE;
        const left = Math.floor(position);
        const right = Math.ceil(position);
        if (right >= end || left < carryStart) break;
        const fraction = position - left;
        const a = combined[left - carryStart]!;
        const b = combined[right - carryStart]!;
        output.push(Math.round(a + (b - a) * fraction));
        resampleOutputCount += 1;
    }
    resampleInputCount = end;
    resampleCarry = combined.slice(-2);
    return Int16Array.from(output);
}

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
};


/** Persistent local standby. No audio leaves the phone before speech wins the gate. */
export async function startVadStandby(onWake: () => void): Promise<boolean> {
    wake = onWake;
    if (active) {
        setVoiceNetworkActive(false);
        return true;
    }
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
        setVoiceNetworkActive(false);
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
            if (Platform.OS !== 'web') {
                try {
                    kitVad = await createKitVad();
                } catch (error) {
                    kitVad = undefined;
                    console.warn('BYOKit standby VAD unavailable; using energy fallback:', error);
                }
            }
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
            resampleInputCount = 0;
            resampleOutputCount = 0;
            resampleCarry = [];
            buffered = [];
            loudFrames = 0;
            noiseFloor = 0.02;
            LiveAudioStream.on('data', inspect);
            await LiveAudioStream.start();
            if (!isOwner(candidate)) {
                await stopRecorder();
                await releaseKitVad();
                if (owner === undefined) { stopVoiceService(); releaseVoiceAudio(); }
                return false;
            }
            return true;
        } catch {
            if (isOwner(candidate)) {
                owner = undefined;
                clearVadState();
                await releaseKitVad();
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

    if (kitVad) {
        const detector = kitVad;
        vadWork = vadWork.then(async () => {
            if (!active || triggered || kitVad !== detector) return;
            try {
                const samples = resampleToVadRate(pcm16(data));
                const frames = samples.length > 0 ? await detector.push(samples) : [];
                if (frames.some((frame) => frame.speech) && !triggered) {
                    triggered = true;
                    console.info('BYOKit standby VAD fired');
                    wake?.();
                }
            } catch (error) {
                kitVad = undefined;
                console.warn('BYOKit standby VAD failed; using energy fallback:', error);
                void detector.release();
                inspectEnergy(data);
            }
        });
        return;
    }
    inspectEnergy(data);
}

function inspectEnergy(data: string): void {
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
    setVoiceNetworkActive(true);
    const candidate: CaptureOwner = { id: ++ownerSequence, kind: 'realtime' };
    const claimed = active && owner?.kind === 'vad' && sampleRate === REALTIME_INPUT_RATE;
    const pending = claimed ? buffered : [];
    owner = candidate;
    clearVadState();
    void releaseKitVad();
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
    setVoiceNetworkActive(false);
    triggered = false;
    loudFrames = 0;
    kitVad?.reset();
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
            await releaseKitVad();
            await stopRecorder();
            stopVoiceService();
            releaseVoiceAudio();
        }
    });
}
