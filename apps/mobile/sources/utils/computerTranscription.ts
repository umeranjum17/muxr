import { Buffer } from 'buffer';
import type { DictateEngine } from '@byokit/dictation';
import { sync } from '@/catalog/sync';

// Hex's first read loads a speech model, which outlasts the usual 40 s request bound.
const COMPUTER_READ_TIMEOUT_MS = 70_000;

/**
 * Dictation read on the paired computer by Hex (host `dictation.transcribe`),
 * not on this phone. The kit still owns capture and the take; this engine only
 * carries the finished recording over the existing link and returns the text.
 * `finalReading: 'recording'` makes that one request per take, with no live
 * words. `id: 'whisper'` is the kit's nearest on-device engine id; the audio
 * never leaves the user's own machines.
 */
export function computerEngine(): DictateEngine {
    return {
        info: { id: 'whisper', model: 'Hex', onDevice: true, streaming: 'utterance', account: 'none' },
        capture: { speechThreshold: 0.015, silenceMs: 500, finalReading: 'recording' },
        async transcribe(input) {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
            const { text } = await sync.request('dictation.transcribe', { audio: Buffer.from(bytes).toString('base64') }, COMPUTER_READ_TIMEOUT_MS);
            const trimmed = text.trim();
            return { text: trimmed, segments: [{ id: '0', text: trimmed, final: true }], usage: { audioMs: Math.round(Math.max(0, bytes.length - 44) / 32), basis: 'free' } };
        },
    };
}
