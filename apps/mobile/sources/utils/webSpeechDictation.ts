/**
 * Browser dictation as a progressive enhancement: the browser's own speech
 * recognition (Web Speech API), where it exists, edits the composer draft.
 * It is not realtime voice — nothing is streamed to the host, no provider
 * is involved — and browsers without the API state that exact limit.
 */
type RecognitionResultList = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
type Recognition = {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: { resultIndex: number; results: RecognitionResultList }) => void) | null;
    onerror: ((event: { error?: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
};

function recognitionConstructor(): (new () => Recognition) | undefined {
    if (typeof window === 'undefined') return undefined;
    const scope = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function webSpeechDictationSupported(): boolean {
    return recognitionConstructor() !== undefined;
}

export const WEB_SPEECH_UNSUPPORTED = 'Dictation needs a browser with built-in speech recognition (Chrome, Edge or Safari). This browser has none, so dictation is off here; typing and realtime voice still work.';

export function startWebSpeechDictation(handlers: { onFinal: (text: string) => void; onEnd: () => void; onError: (message: string) => void }): { stop: () => void } {
    const Constructor = recognitionConstructor();
    if (Constructor === undefined) throw new Error(WEB_SPEECH_UNSUPPORTED);
    const recognition = new Constructor();
    recognition.lang = typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result?.isFinal) handlers.onFinal(Array.from(result, (part) => part.transcript).join(''));
        }
    };
    recognition.onerror = (event) => {
        // 'aborted' is our own stop; 'no-speech' just means silence.
        if (event.error === 'aborted' || event.error === 'no-speech') return;
        handlers.onError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? 'The browser blocked the microphone for dictation. Allow the microphone for this site and try again.'
            : `Dictation stopped: ${event.error ?? 'unknown error'}.`);
    };
    recognition.onend = () => handlers.onEnd();
    recognition.start();
    return { stop: () => recognition.stop() };
}
