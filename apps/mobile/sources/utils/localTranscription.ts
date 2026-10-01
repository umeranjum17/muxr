import { Dictation, whisperRnEngine } from '@byokit/dictation';
import { initWhisper } from 'whisper.rn';
import { loadLocalSettings } from '@/catalog/application/persistence';
import { BUNDLED_DICTATION_MODEL_ID, getInstalledDictationModelUri } from '@/utils/dictationModels';
import { getBundledDictationModelUri } from '@/utils/dictationModelFiles';
import { dictationMicrophone } from '@/utils/dictationMicrophone';

const KEEP_WARM_MS = 3 * 60_000;
const VOCABULARY_PROMPT = 'muxr, Herdr, Codex, Claude, BYOKit, worktree, npm.';
let warm: { modelId: string; engine: ReturnType<typeof whisperRnEngine> } | null = null;
let coolTimer: ReturnType<typeof setTimeout> | undefined;

async function acquireEngine(modelId: string) {
    clearTimeout(coolTimer);
    if (warm?.modelId === modelId) return warm.engine;
    const previous = warm;
    warm = null;
    await previous?.engine.release();
    const engine = whisperRnEngine({
        model: getInstalledDictationModelUri(modelId) ?? await getBundledDictationModelUri(),
        multilingual: modelId !== BUNDLED_DICTATION_MODEL_ID,
        initWhisper,
        settings: { initialPrompt: VOCABULARY_PROMPT, beamSize: 5 },
    });
    warm = { modelId, engine };
    return engine;
}

function coolEngine(): void {
    clearTimeout(coolTimer);
    coolTimer = setTimeout(() => {
        const previous = warm;
        warm = null;
        void previous?.engine.release().catch((error) => console.error('Could not release dictation model:', error));
    }, KEEP_WARM_MS);
}

export type LiveTranscription = {
    finish(): Promise<string>;
    cancel(): void;
};

/** App-owned capture and preferences; BYOKit owns recognition and transcript settlement. */
export async function startLiveTranscription({ hint, onText, onLevel }: {
    hint?: string;
    onText: (text: string) => void;
    onLevel: (level: number) => void;
}): Promise<LiveTranscription> {
    const settings = loadLocalSettings();
    const engine = await acquireEngine(settings.dictationModel || BUNDLED_DICTATION_MODEL_ID);
    const mic = dictationMicrophone();
    const handle = new Dictation({ engine, audio: mic.audio }).listen({
        onDeviceOnly: true,
        languages: settings.dictationLanguage ? [settings.dictationLanguage] : undefined,
        prompt: hint,
        replacements: Object.fromEntries(settings.dictationWordReplacements.map(({ from, to }) => [from, to])),
    });
    handle.on('partial', ({ segment }) => onText(segment.text));
    handle.on('level', ({ rms }) => onLevel(rms));
    try {
        await mic.opened;
    } catch (error) {
        handle.cancel();
        coolEngine();
        throw error;
    }
    return {
        async finish() {
            try {
                return (await handle.finish()).text;
            } finally {
                coolEngine();
            }
        },
        cancel() {
            handle.cancel();
            coolEngine();
        },
    };
}
