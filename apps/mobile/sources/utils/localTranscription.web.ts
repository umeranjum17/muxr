import type { LiveTranscription } from './localTranscription';

export async function startLiveTranscription(_options: {
    hint?: string;
    onText: (text: string) => void;
    onLevel: (level: number) => void;
}): Promise<LiveTranscription> {
    throw new Error('On-device dictation is available in the Android and iOS apps.');
}
