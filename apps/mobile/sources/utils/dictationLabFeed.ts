import type { AudioFrame } from '@byokit/dictation';

// Lab-only file feed for the done-done-verify-pockit dictation proof. The flag is inlined at build
// time, so production bundles keep no branch. The lab pushes raw little-endian PCM16 mono
// at the kit rate to `<app files>/muxr-lab-dictation.pcm`; the next take plays that file
// through the dictation microphone instead of opening the hardware mic.
const LAB_FEED_NAME = 'muxr-lab-dictation.pcm';
const FRAME_SAMPLES = 2560;

export async function readLabDictationFeed(rate: number): Promise<AudioFrame[] | null> {
    if (process.env.EXPO_PUBLIC_MUXR_LAB_DICTATE !== '1') return null;
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.document, LAB_FEED_NAME);
    if (!file.exists) return null;
    const bytes = await file.bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
    const frames: AudioFrame[] = [];
    // `at` follows the native path's convention: milliseconds at 16 kHz.
    for (let start = 0, at = 0; start < samples.length; start += FRAME_SAMPLES) {
        const data = samples.slice(start, start + FRAME_SAMPLES);
        frames.push({ data, at });
        at += data.length / (rate / 1000);
    }
    return frames;
}
