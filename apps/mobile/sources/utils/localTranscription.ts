import { Buffer } from 'buffer';
import LiveAudioStream from 'react-native-live-audio-stream';
import { initWhisper, type WhisperContext } from 'whisper.rn';
import { loadLocalSettings } from '@/catalog/application/persistence';
import { applyWordReplacements, pcm16ChunksToArrayBuffer, settleWords } from '@/utils/transcription';
import { BUNDLED_DICTATION_MODEL_ID, getInstalledDictationModelUri } from '@/utils/dictationModels';
import { bundledDictationModel } from '@/utils/dictationModelFiles';

const BYTES_PER_SECOND = 16_000 * 2;
const LIVE_WINDOW_BYTES = 30 * BYTES_PER_SECOND;
// Read what has been said again once this much more has arrived.
const READ_EVERY_BYTES = BYTES_PER_SECOND;
// Below this level a chunk holds no speech.
const SILENT_LEVEL = 0.06;
// Six threads read fastest on a current flagship phone; eight start competing
// with the app itself.
const THREADS = 6;
// Loading the model is part of the wait after every tap, so it stays loaded
// between dictations and is let go once dictation has gone quiet.
const KEEP_WARM_MS = 3 * 60_000;

let warm: { modelId: string; context: Promise<WhisperContext> } | null = null;
let coolTimer: ReturnType<typeof setTimeout> | undefined;
// A whisper.cpp context takes one reading at a time, so a dictation begins
// only once the one before it has finished with the shared model.
let previousDone: Promise<void> = Promise.resolve();

function acquireModel(modelId: string): Promise<WhisperContext> {
    clearTimeout(coolTimer);
    if (warm?.modelId !== modelId) {
        void releaseModel(warm?.context);
        const context = initWhisper({ filePath: getInstalledDictationModelUri(modelId) ?? bundledDictationModel });
        warm = { modelId, context };
        context.catch(() => { if (warm?.context === context) warm = null; });
    }
    return warm.context;
}

function coolModel(): void {
    clearTimeout(coolTimer);
    coolTimer = setTimeout(() => {
        const context = warm?.context;
        warm = null;
        void releaseModel(context);
    }, KEEP_WARM_MS);
}

async function releaseModel(context: Promise<WhisperContext> | undefined): Promise<void> {
    await (await context?.catch(() => null))?.release().catch(() => undefined);
}

/**
 * whisper.cpp reads a fixed 30 s window unless told the audio is shorter; a
 * window sized to the audio makes a short reading several times faster. It
 * also drops or repeats words, noisy audio worst (scripts/dictation), so only
 * the live words use it and the transcript is read with the full window.
 */
function audioContextFor(bytes: number): number {
    return Math.min(1500, Math.ceil((bytes / BYTES_PER_SECOND) * 50) + 256);
}

/** Real input level from the PCM chunks already flowing to Whisper; no extra capture. */
function rmsLevel(buf: Buffer): number {
    const samples = Math.floor(buf.length / 2);
    if (samples === 0) return 0;
    const step = Math.max(1, Math.floor(samples / 64));
    let sum = 0;
    let count = 0;
    for (let i = 0; i < samples; i += step) {
        const s = buf.readInt16LE(i * 2) / 32768;
        sum += s * s;
        count += 1;
    }
    return Math.min(1, Math.sqrt(sum / count) * 4);
}

export type LiveTranscription = {
    /** Stop the microphone and resolve with the finished transcript. */
    finish(): Promise<string>;
    /** Stop the microphone and drop everything heard. */
    cancel(): void;
};

/**
 * Dictate on-device with whisper.cpp while the user speaks. Everything said
 * is read again every second, in the background, and its words show once two
 * readings agree. Stopping reads it all once more with the full window, which
 * is the transcript.
 */
export async function startLiveTranscription({ hint, onText, onLevel }: {
    hint?: string;
    onText: (text: string) => void;
    onLevel: (level: number) => void;
}): Promise<LiveTranscription> {
    const settings = loadLocalSettings();
    const replacements = settings.dictationWordReplacements;
    const modelId = settings.dictationModel || BUNDLED_DICTATION_MODEL_ID;
    // The bundled model only knows English; 'auto' would still run a language
    // detection pass on every reading and throw its answer away.
    const language = modelId === BUNDLED_DICTATION_MODEL_ID ? 'en' : settings.dictationLanguage ?? 'auto';

    const chunks: string[] = [];
    // Each chunk's level and where it ends, to tell whether unread audio holds speech.
    const levels: { level: number; end: number }[] = [];
    let total = 0;
    let recording = false;
    let cancelled = false;
    // The latest reading: how far it reached and what it heard.
    let readTo = 0;
    let previewFrom = 0;
    let previewChunk = 0;
    let readChunk = 0;
    let prefix = '';
    let heard = '';
    let shown = '';
    let reading: { stop: () => Promise<void>; done: Promise<void> } | null = null;

    const spokenAfter = (at: number) => levels.some(({ level, end }) => end > at && level >= SILENT_LEVEL);
    const text = (said: string) => applyWordReplacements(said, replacements).trim();
    const liveText = () => [prefix, shown].filter(Boolean).join(' ');

    const model = previousDone.then(() => acquireModel(modelId));
    let released!: () => void;
    previousDone = new Promise<void>((resolve) => { released = resolve; });
    const done = () => void model.then(coolModel, coolModel).finally(released);
    const stopMicrophone = async () => {
        if (!recording) return;
        recording = false;
        await LiveAudioStream.stop();
    };

    const read = async (context: WhisperContext, to: number, live: boolean) => {
        const from = live ? previewFrom : 0;
        const chunkCount = chunks.length;
        const job = context.transcribeData(pcm16ChunksToArrayBuffer(live ? chunks.slice(previewChunk, chunkCount) : chunks), {
            language,
            maxThreads: THREADS,
            ...(live ? { audioCtx: audioContextFor(to - from) } : {}),
            prompt: hint,
        });
        const done = job.promise.then(() => undefined, () => undefined);
        reading = { stop: job.stop, done };
        try {
            const { result, isAborted } = await job.promise;
            if (isAborted) return false;
            shown = recording ? settleWords(shown, heard, result.trim()) : result.trim();
            heard = result.trim();
            readTo = to;
            readChunk = chunkCount;
            return true;
        } finally {
            reading = null;
        }
    };

    const follow = () => {
        if (!recording || reading !== null || total - readTo < READ_EVERY_BYTES) return;
        // Nothing new has been said; the last reading still stands.
        if (!spokenAfter(readTo)) return;
        if (total - previewFrom > LIVE_WINDOW_BYTES) {
            prefix = [prefix, shown].filter(Boolean).join(' ');
            previewFrom = readTo;
            previewChunk = readChunk;
            heard = '';
            shown = '';
        }
        void model.then(async (context) => {
            if (!recording || reading !== null) return;
            if (await read(context, total, true).catch(() => false)) {
                if (recording && !cancelled) onText(text(liveText()));
            }
            follow();
        }, () => undefined);
    };

    await LiveAudioStream.init({
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        bufferSize: 2560,
        wavFile: '',
    });
    LiveAudioStream.on('data', (chunk) => {
        if (!recording) return;
        chunks.push(chunk);
        const buf = Buffer.from(chunk, 'base64');
        const level = rmsLevel(buf);
        total += buf.byteLength;
        levels.push({ level, end: total });
        onLevel(level);
        follow();
    });
    recording = true;
    try {
        await LiveAudioStream.start();
    } catch (error) {
        recording = false;
        done();
        throw error;
    }

    let finishing: Promise<unknown> = Promise.resolve();

    const finish = async (): Promise<string> => {
        await stopMicrophone();
        const context = await model;
        // The model reads one thing at a time; let a running reading land.
        await reading?.done;
        if (cancelled) return '';
        if (total > 0) await read(context, total, false);
        return cancelled ? '' : text(heard);
    };

    return {
        finish() {
            const finished = finish();
            finishing = finished.catch(() => undefined);
            void finishing.finally(done);
            return finished;
        },
        cancel() {
            cancelled = true;
            void reading?.stop().catch(() => undefined);
            void Promise.all([stopMicrophone().catch(() => undefined), finishing]).finally(done);
        },
    };
}
