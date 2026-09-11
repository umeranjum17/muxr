import { encodeBase64 } from '@/encryption/base64';
import type { RealtimeRecorder } from './realtimeCapture';

/**
 * Browser microphone recorder behind the realtime capture contract: the
 * browser resamples getUserMedia input to the requested rate, frames are
 * mono PCM16 base64 exactly like the native recorder emits, and release
 * stops every track and closes the context. Foreground-only by platform
 * design: a suspended tab stops producing frames until it returns.
 *
 * No dependency beyond Web Audio. The ScriptProcessor path avoids worker
 * CSP questions entirely; 2048 frames at 24 kHz is ~85 ms per chunk.
 */
const PROCESSOR_FRAMES = 2048;

/** Float32 [-1, 1] to little-endian PCM16 bytes. Pure: unit-covered. */
export function floatToPcm16Bytes(samples: Float32Array): Uint8Array {
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);
    for (let index = 0; index < samples.length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[index]!));
        const pcm = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
        view.setInt16(index * 2, pcm, true);
    }
    return out;
}

/** One PCM16 base64 frame from an audio chunk. Pure: unit-covered. */
export function encodePcm16Chunk(samples: Float32Array): string {
    return encodeBase64(floatToPcm16Bytes(samples), 'base64');
}

export function openRealtimeRecorder(): RealtimeRecorder {
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: ScriptProcessorNode | undefined;
    let sink: GainNode | undefined;
    let resumeListener: (() => void) | undefined;
    const listeners = new Set<(base64: string) => void>();
    let closed = false;

    const teardown = (): void => {
        if (resumeListener !== undefined && typeof window !== 'undefined') {
            window.removeEventListener('pointerdown', resumeListener);
            window.removeEventListener('keydown', resumeListener);
            resumeListener = undefined;
        }
        try {
            processor?.disconnect();
        } catch {
            // Already disconnected during a racing stop.
        }
        try {
            source?.disconnect();
        } catch {
            // Already disconnected during a racing stop.
        }
        processor = undefined;
        source = undefined;
        sink = undefined;
        for (const track of stream?.getTracks() ?? []) {
            try {
                track.stop();
            } catch {
                // A released device stays released.
            }
        }
        stream = undefined;
        const closing = context;
        context = undefined;
        if (closing !== undefined && closing.state !== 'closed') {
            void closing.close().catch(() => undefined);
        }
    };

    return {
        init: async (sampleRate: number): Promise<void> => {
            if (closed) throw new Error('Realtime web recorder is closed.');
            if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
                throw new Error('This browser cannot capture microphone audio.');
            }
            // Permission denial is named as such so the overlay can say what
            // to do; other failures keep their platform message.
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true },
                });
            } catch (cause) {
                // The platform name stays on the error (callers match it);
                // the message becomes the sentence the overlay shows.
                const name = cause instanceof Error ? cause.name : '';
                let message: string | undefined;
                if (name === 'NotAllowedError' || name === 'SecurityError') message = 'Microphone permission denied for this site.';
                if (name === 'NotFoundError' || name === 'OverconstrainedError') message = 'No microphone was found on this device.';
                if (message === undefined) throw cause instanceof Error ? cause : new Error(String(cause));
                throw Object.assign(new Error(message), { name });
            }
            try {
                context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
            } catch (cause) {
                for (const track of stream.getTracks()) {
                    try {
                        track.stop();
                    } catch {
                        // Best effort on a half-built recorder.
                    }
                }
                stream = undefined;
                throw cause instanceof Error ? cause : new Error(String(cause));
            }
            // Sticky user activation (the tap that started the call) lets a
            // later-created context run; resume defensively either way.
            const resume = (): void => {
                void context?.resume().catch(() => undefined);
            };
            resume();
            if (typeof window !== 'undefined') {
                resumeListener = resume;
                window.addEventListener('pointerdown', resumeListener);
                window.addEventListener('keydown', resumeListener);
            }
            source = context.createMediaStreamSource(stream);
            processor = context.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
            processor.onaudioprocess = (event: AudioProcessingEvent) => {
                if (closed) return;
                const input = event.inputBuffer.getChannelData(0);
                const frame = encodePcm16Chunk(input);
                for (const listener of [...listeners]) listener(frame);
            };
            sink = context.createGain();
            sink.gain.value = 0;
            source.connect(processor);
            processor.connect(sink);
            sink.connect(context.destination);
        },
        start: async (): Promise<void> => {
            if (closed) throw new Error('Realtime web recorder is closed.');
            if (context === undefined || stream === undefined) {
                throw new Error('Realtime web recorder is not initialized.');
            }
            // "Listening" must mean frames are flowing: a context the browser
            // keeps suspended (no user activation, autoplay policy) produces
            // silence, so give it a moment to resume and otherwise say so.
            await context.resume().catch(() => undefined);
            for (let waited = 0; context.state !== 'running' && waited < 1500; waited += 100) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                await context.resume().catch(() => undefined);
            }
            if (context.state !== 'running') throw new Error('Audio is suspended by the browser until you tap the page.');
        },
        stop: async (): Promise<void> => {
            closed = true;
            listeners.clear();
            teardown();
        },
        onData: (listener: (base64: string) => void): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
