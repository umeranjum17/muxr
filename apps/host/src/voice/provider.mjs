import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The installed speech-to-speech adapters. `key` is the secret filename under
 * $MUXR_HOME; adapters that authenticate through an existing CLI login have none.
 */
export const PROVIDERS = [
    { id: 'xai', name: 'Grok', description: 'Grok on xAI. Needs an xAI API key on this machine.', setup: 'api-key', secret: 'xai.key', keyLabel: 'xAI', placeholder: 'xai-…' },
    { id: 'gemini', name: 'Gemini Live', description: 'Gemini Live on Google. Needs a Gemini API key on this machine.', setup: 'api-key', secret: 'gemini.key', keyLabel: 'Gemini', placeholder: 'AIza…' },
    { id: 'openai', name: 'OpenAI Realtime', description: 'OpenAI Realtime. Needs an OpenAI API key on this machine.', setup: 'api-key', secret: 'openai.key', keyLabel: 'OpenAI', placeholder: 'sk-…' },
    { id: 'codex', name: 'Codex Voice (experimental)', description: 'Codex Voice, experimental. Uses the ChatGPT login on this machine, no API key.', setup: 'codex-login', keyLabel: 'Codex', placeholder: '' },
];

const DEFAULT_ID = 'codex';
const LEGACY_PLUGIN_IDS = new Map([
    ['muxr.voice-gemini', 'gemini'],
    ['muxr.voice-openai', 'openai'],
    ['muxr.voice-codex', 'codex'],
]);

function stateFile() {
    // Product state, not plugin state: the selection belongs to muxr, and the
    // plugin directory that used to hold it no longer exists.
    const home = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    return join(home, 'voice', 'provider');
}

export function providerById(id) {
    return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The id is used to resolve a module path, so it is matched against the fixed
 * table rather than sanitized; an unknown or unreadable value falls back.
 */
export function selectedProvider() {
    try {
        return providerById(readFileSync(stateFile(), 'utf8').trim()) ?? providerById(DEFAULT_ID);
    } catch {
        return providerById(DEFAULT_ID);
    }
}

export function selectProvider(id) {
    const provider = providerById(String(id ?? '').trim());
    if (provider === undefined) throw new Error('unknown realtime voice provider');
    const file = stateFile();
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(file, `${provider.id}\n`, { mode: 0o600 });
    return provider;
}

/**
 * The retired single-plugin release kept the choice in plugin state, and the
 * older per-plugin releases only in the enabled registration. muxr's own file
 * wins: a legacy value is read only when it does not exist yet.
 */
export function migrateLegacyProvider(installed, targetDir, legacyStateFile, dryRun = false) {
    const file = join(targetDir, 'provider');
    try {
        const selected = providerById(readFileSync(file, 'utf8').trim());
        if (selected === undefined) throw new Error('realtime voice provider state is invalid');
        return selected;
    } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
    }

    const enabled = installed
        .filter((plugin) => plugin?.enabled === true)
        .map((plugin) => LEGACY_PLUGIN_IDS.get(plugin.plugin_id))
        .filter((id) => id !== undefined);
    if (enabled.length > 1) throw new Error('multiple legacy realtime voice providers are enabled');

    const selected = retiredPluginSelection(legacyStateFile)
        ?? (enabled.length === 1 ? providerById(enabled[0]) : undefined);
    if (selected === undefined) return undefined;
    if (!dryRun) {
        mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        chmodSync(targetDir, 0o700);
        writeFileSync(file, `${selected.id}\n`, { mode: 0o600, flag: 'wx' });
    }
    return selected;
}

/** An unreadable or unknown legacy value is treated as no selection at all. */
function retiredPluginSelection(legacyStateFile) {
    try {
        return providerById(readFileSync(legacyStateFile, 'utf8').trim());
    } catch {
        return undefined;
    }
}
