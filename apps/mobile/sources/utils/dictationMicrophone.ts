import { Buffer } from 'buffer';
import LiveAudioStream from 'react-native-live-audio-stream';
import type { AudioFrame, AudioMic, AudioMicStream } from '@byokit/dictation';

/** Permissions and microphone ownership are acquired by the dictation UI. */
export function dictationMicrophone(): { audio: AudioMic; opened: Promise<void> } {
    let opened!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { opened = resolve; failed = reject; });
    return {
        opened: ready,
        audio: {
            async open({ rate }) {
                const frames: AudioFrame[] = [];
                let wake: (() => void) | undefined;
                let recording = false;
                let stopped: Promise<void> | undefined;
                let at = 0;
                const stream: AudioMicStream = {
                    stop() {
                        if (stopped) return stopped;
                        stopped = Promise.resolve()
                            .then(() => LiveAudioStream.stop())
                            .then(() => undefined)
                            .finally(() => {
                                recording = false;
                                wake?.();
                            });
                        return stopped;
                    },
                    async *[Symbol.asyncIterator]() {
                        while (recording || frames.length > 0) {
                            const frame = frames.shift();
                            if (frame) {
                                yield frame;
                                continue;
                            }
                            await new Promise<void>((resolve) => { wake = resolve; });
                            wake = undefined;
                        }
                    },
                };
                try {
                    await LiveAudioStream.init({
                        sampleRate: rate, channels: 1, bitsPerSample: 16,
                        audioSource: 6, bufferSize: 2560, wavFile: '',
                    });
                    LiveAudioStream.on('data', (chunk) => {
                        if (!recording) return;
                        const bytes = Buffer.from(chunk, 'base64');
                        const data = new Int16Array(Math.floor(bytes.length / 2));
                        for (let i = 0; i < data.length; i++) data[i] = bytes.readInt16LE(i * 2);
                        frames.push({ data, at });
                        at += data.length / 16;
                        wake?.();
                    });
                    recording = true;
                    await LiveAudioStream.start();
                    opened();
                    return stream;
                } catch (error) {
                    await stream.stop().catch(() => undefined); // Startup failed; ownership is released by the caller.
                    failed(error);
                    throw error;
                }
            },
        },
    };
}
