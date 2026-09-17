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

import { decodeBase64 } from '@/encryption/base64';

export type EnergyDirection = 'input' | 'output';

const DECAY_PER_MS = 0.0038;
/** Sixteen-bit PCM at conversational level rarely passes a third of full scale. */
const FULL_SCALE = 9_000;
/** One read every few hundred samples: loudness needs a shape, not every sample. */
const STRIDE = 16;

let input = 0;
let output = 0;
let inputAt = Date.now();
let outputAt = Date.now();
type EnergyListener = (direction: EnergyDirection, level: number) => void;
const listeners = new Set<EnergyListener>();

function decayed(value: number, since: number, now: number): number {
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
        input = Math.max(decayed(input, inputAt, now), level);
        inputAt = now;
        for (const listener of listeners) listener('input', input);
    } else {
        output = Math.max(decayed(output, outputAt, now), level);
        outputAt = now;
        for (const listener of listeners) listener('output', output);
    }
}

/** PCM arrives on JS; shared values carry only the bounded level to the UI thread. */
export function subscribeEnergy(listener: EnergyListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function resetEnergy(): void {
    input = 0;
    output = 0;
    inputAt = Date.now();
    outputAt = Date.now();
    for (const listener of listeners) {
        listener('input', 0);
        listener('output', 0);
    }
}
