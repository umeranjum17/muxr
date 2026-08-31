import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The installed speech-to-speech adapters. `key` is the secret filename under
 * $MUXR_HOME; adapters that authenticate through an existing CLI login have none.
 */
export const PROVIDERS = [
    { id: 'xai', name: 'Grok', secret: 'xai.key', keyLabel: 'xAI', placeholder: 'xai-…' },
    { id: 'gemini', name: 'Gemini Live', secret: 'gemini.key', keyLabel: 'Gemini', placeholder: 'AIza…' },
    { id: 'openai', name: 'OpenAI Realtime', secret: 'openai.key', keyLabel: 'OpenAI', placeholder: 'sk-…' },
    { id: 'codex', name: 'Codex Voice (experimental)', keyLabel: 'Codex', placeholder: '' },
];

const DEFAULT_ID = 'xai';

function stateFile() {
    const state = process.env.MUXR_PLUGIN_STATE_DIR?.trim();
    return state ? join(state, 'provider') : undefined;
}

export function providerById(id) {
    return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The id is used to resolve a module path, so it is matched against the fixed
 * table rather than sanitized; an unknown or unreadable value falls back.
 */
export function selectedProvider() {
    const file = stateFile();
    if (file === undefined) return providerById(DEFAULT_ID);
    try {
        return providerById(readFileSync(file, 'utf8').trim()) ?? providerById(DEFAULT_ID);
    } catch {
        return providerById(DEFAULT_ID);
    }
}

export function selectProvider(id) {
    const provider = providerById(String(id ?? '').trim());
    if (provider === undefined) throw new Error('unknown realtime voice provider');
    const file = stateFile();
    if (file === undefined) throw new Error('plugin state directory is unavailable');
    writeFileSync(file, `${provider.id}\n`, { mode: 0o600 });
    return provider;
}
