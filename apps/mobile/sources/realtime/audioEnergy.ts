/**
 * How loud the conversation is, right now, in both directions.
 *
 * The PCM already passes through this client on its way to and from the
 * provider, so the loudness is free: no wire field, no host change, no second
 * capture. What was missing was anyone reading it, which is why the session
 * visual could only ever act out a state instead of answering a voice.
 *
 * Energy decays on its own. A talker's waveform is full of gaps at word
 * boundaries, and a visual that tracked them exactly would strobe; decay makes
 * it fall like a VU needle instead.
 */

import { makeMutable } from 'react-native-reanimated';
import { decodeBase64 } from '@/encryption/base64';

export type EnergyDirection = 'input' | 'output';

const DECAY_PER_MS = 0.0038;
/** Sixteen-bit PCM at conversational level rarely passes a third of full scale. */
const FULL_SCALE = 9_000;
/** One read every few hundred samples: loudness needs a shape, not every sample. */
const STRIDE = 16;

// Shared values, not module state. The PCM arrives on the JS thread, but the
// session visual reads the loudness from a frame callback on the UI runtime,
// and a `let` only exists on the runtime that wrote it. Worse: the worklets
// plugin captures a plain imported function into the closure without a worklet
// hash, so on the UI runtime `readEnergy` materialised as a stub that throws —
// which took down the whole React host, blanking the app the moment any voice
// control was tapped.
const input = makeMutable(0);
const output = makeMutable(0);
const inputAt = makeMutable(Date.now());
const outputAt = makeMutable(Date.now());

function decayed(value: number, since: number, now: number): number {
    'worklet';
    return Math.max(0, value - (now - since) * DECAY_PER_MS);
}

/** Root mean square of a base64 PCM16 chunk, sampled rather than summed. */
export function chunkEnergy(base64: string): number {
    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(base64);
    } catch {
        return 0;
    }
    const samples = Math.floor(bytes.length / 2);
    if (samples === 0) return 0;
    let sum = 0;
    let count = 0;
    for (let index = 0; index < samples; index += STRIDE) {
        const low = bytes[index * 2]!;
        const high = bytes[index * 2 + 1]!;
        // Little-endian signed 16-bit.
        const raw = (high << 8) | low;
        const value = raw >= 0x8000 ? raw - 0x10000 : raw;
        sum += value * value;
        count += 1;
    }
    if (count === 0) return 0;
    return Math.min(1, Math.sqrt(sum / count) / FULL_SCALE);
}

export function reportEnergy(direction: EnergyDirection, base64: string): void {
    const level = chunkEnergy(base64);
    const now = Date.now();
    if (direction === 'input') {
        input.value = Math.max(decayed(input.value, inputAt.value, now), level);
        inputAt.value = now;
    } else {
        output.value = Math.max(decayed(output.value, outputAt.value, now), level);
        outputAt.value = now;
    }
}

/** Called from the session visual's frame callback, on the UI runtime. */
export function readEnergy(direction: EnergyDirection): number {
    'worklet';
    const now = Date.now();
    return direction === 'input'
        ? decayed(input.value, inputAt.value, now)
        : decayed(output.value, outputAt.value, now);
}

export function resetEnergy(): void {
    input.value = 0;
    output.value = 0;
    inputAt.value = Date.now();
    outputAt.value = Date.now();
}
