import { Dictation, whisperRnEngine } from '@byokit/dictation';
import { initWhisper } from 'whisper.rn';
import { loadLocalSettings } from '@/catalog/application/persistence';
import { BUNDLED_DICTATION_MODEL_ID, getInstalledDictationModelUri } from '@/utils/dictationModels';
import { getBundledDictationModelUri } from '@/utils/dictationModelFiles';
import { dictationMicrophone } from '@/utils/dictationMicrophone';

const KEEP_WARM_MS = 3 * 60_000;
const VOCABULARY_PROMPT = 'muxr, Herdr, Crewhouse, Treehouse, OpenClaw, ChatGPT, Codex, Claude, BYOKit, worktree, npm.';
// Phone room noise reads 0.003-0.005 RMS, over the kit's default speech gate, so live
// readings started on silence and stuck on "[BLANK_AUDIO]". The final reads the whole take either way.
const SPEECH_GATE_RMS = 0.015;
let warm: { modelUri: string; multilingual: boolean; engine: ReturnType<typeof whisperRnEngine> } | null = null;

// whisper annotates non-speech audio with short parenthetical or bracketed
// labels like "(wind howling)", "[wind]" or "[inaudible]", and music as "♪".
// They describe the room, not the speaker, and must never reach the composer. Legitimate words in parentheses
// or brackets survive: a group is dropped only when every word in it is a
// known non-speech label.
// ponytail: bounded non-speech vocabulary; a novel sound word outside the set
// would slip through, extend NON_SPEECH when that happens.
const NON_SPEECH = new Set([
    'blank', 'audio',
    'silence', 'quiet', 'inaudible', 'unintelligible', 'indistinct', 'mumbling', 'muttering', 'muffled', 'static',
    'background', 'chatter', 'chattering', 'crosstalk',
    'wind', 'howling', 'water', 'rushing', 'gust', 'breeze', 'rain', 'thunder', 'storm', 'hail',
    'music', 'song', 'singing', 'hum', 'humming', 'melody',
    'noise', 'sound', 'sounds', 'buzzing', 'beep', 'beeping', 'ticking', 'clicking', 'rumble', 'rumbling',
    'applause', 'clapping', 'cheering', 'screaming', 'shouting', 'yelling',
    'laughter', 'laughing', 'crying', 'sobbing', 'whisper', 'whispering', 'gasping', 'sigh', 'sighing', 'groaning',
    'dog', 'barking', 'cat', 'meowing', 'birds', 'bird', 'car', 'engine', 'traffic', 'honking', 'siren', 'airplane', 'train',
    'tv', 'radio', 'phone', 'ringing',
]);

function dropNonSpeechLabels(text: string): string {
    const isNoise = (inner: string) => {
        const words = inner.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
        return words.length === 0 || words.every((word) => NON_SPEECH.has(word));
    };
    return text
        .replace(/\([^()]*\)/g, (group) => (isNoise(group.slice(1, -1)) ? '' : group))
        .replace(/\[[^\]]*\]/g, (group) => (isNoise(group.slice(1, -1)) ? '' : group))
        .replace(/[♪♫]+/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

let coolTimer: ReturnType<typeof setTimeout> | undefined;

async function acquireEngine(modelId: string) {
    clearTimeout(coolTimer);
    const installedModelUri = getInstalledDictationModelUri(modelId);
    const modelUri = installedModelUri ?? await getBundledDictationModelUri();
    const multilingual = installedModelUri !== null && modelId !== BUNDLED_DICTATION_MODEL_ID;
    if (warm?.modelUri === modelUri) return warm;
    const previous = warm;
    warm = null;
    await previous?.engine.release();
    const engine = whisperRnEngine({
        model: modelUri,
        multilingual,
        initWhisper,
        settings: { initialPrompt: VOCABULARY_PROMPT, beamSize: 5, vad: { threshold: SPEECH_GATE_RMS } },
    });
    warm = { modelUri, multilingual, engine };
    return warm;
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
export async function startLiveTranscription({ hint, keywords, onText, onLevel }: {
    hint?: string;
    keywords?: string[];
    onText: (text: string) => void;
    onLevel: (level: number) => void;
}): Promise<LiveTranscription> {
    const settings = loadLocalSettings();
    const selectedEngine = await acquireEngine(settings.dictationModel || BUNDLED_DICTATION_MODEL_ID);
    const mic = dictationMicrophone();
    const handle = new Dictation({ engine: selectedEngine.engine, audio: mic.audio }).listen({
        onDeviceOnly: true,
        languages: selectedEngine.multilingual ? (settings.dictationLanguage ? [settings.dictationLanguage] : undefined) : ['en'],
        prompt: hint,
        keywords,
        replacements: Object.fromEntries(settings.dictationWordReplacements.map(({ from, to }) => [from, to])),
    });
    handle.on('partial', ({ segment }) => onText(dropNonSpeechLabels(segment.text)));
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
                return dropNonSpeechLabels((await handle.finish()).text);
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
