import LiveAudioStream from 'react-native-live-audio-stream';

/**
 * Native microphone recorder behind the realtime capture contract: mono
 * PCM16 base64 frames into onData, released explicitly. The VAD/realtime
 * ownership machine in vadStandby never touches LiveAudioStream directly,
 * so the web build swaps this module without touching that logic.
 */
export interface RealtimeRecorder {
    init(sampleRate: number): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onData(listener: (base64: string) => void): () => void;
}

export function openRealtimeRecorder(): RealtimeRecorder {
    let subscription: { remove: () => void } | undefined;
    const forget = (): void => {
        try {
            subscription?.remove();
        } catch {
            // Teardown stays best-effort when the recorder is already gone.
        }
        subscription = undefined;
    };
    return {
        init: async (rate: number): Promise<void> => {
            await LiveAudioStream.init({
                sampleRate: rate,
                channels: 1,
                bitsPerSample: 16,
                audioSource: 7,
                bufferSize: 4_800,
                wavFile: '',
            });
        },
        start: async (): Promise<void> => {
            await LiveAudioStream.start();
        },
        stop: async (): Promise<void> => {
            forget();
            await Promise.resolve(LiveAudioStream.stop()).catch(() => undefined);
        },
        onData: (listener: (base64: string) => void): (() => void) => {
            forget();
            // The native emitter returns its subscription; the cast only
            // recovers what the untyped JS module does not declare.
            subscription = LiveAudioStream.on('data', listener) as unknown as { remove: () => void };
            return forget;
        },
    };
}
