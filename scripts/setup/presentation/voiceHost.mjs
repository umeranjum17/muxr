/**
 * `muxr voice`: realtime voice provider configuration on the host.
 *
 * Provider policy, credentials and model choice are host/plugin-owned. This
 * command is the only place they are set: it drives the bundled voice
 * plugin's own provider table and owner-only key store, so the Herdr pane,
 * the interactive menu and automation all change the same state. Clients
 * only ever learn "configured" or "unavailable".
 *
 *   muxr voice                       interactive: choose a provider, set its key
 *   muxr voice status [--json]       readiness per provider, never the key
 *   muxr voice select <id>           choose the provider clients will use
 *   muxr voice key set [--stdin]     set the selected provider's key (hidden prompt or stdin)
 *   muxr voice key clear             remove the selected provider's key
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginFolder } from '../infrastructure/paths.mjs';
import { stateDir } from '../infrastructure/runtime.mjs';
import { heading, promptSecret, select, status } from './ui.mjs';

const VOICE_PLUGIN_ID = 'muxr.voice';

async function voicePlugin() {
    // The plugin resolves its selection file from this directory, exactly as
    // the host does when it spawns the plugin.
    process.env.MUXR_PLUGIN_STATE_DIR = join(stateDir(), 'plugin-state', VOICE_PLUGIN_ID);
    mkdirSync(process.env.MUXR_PLUGIN_STATE_DIR, { recursive: true, mode: 0o700 });
    const folder = pluginFolder('voice');
    const provider = await import(pathToFileURL(join(folder, 'provider.mjs')).href);
    const { providerSecret } = await import(pathToFileURL(join(folder, 'providerSecret.mjs')).href);
    const secretFor = (entry) => entry.secret === undefined ? undefined : providerSecret(entry.secret, {
        notDirectory: `${entry.keyLabel} key store must be a real directory`,
        missing: `No ${entry.keyLabel} key set`,
        ownerOnly: `${entry.keyLabel} key store must be owner-only`,
        empty: `${entry.keyLabel} key must not be empty`,
        notRegular: 'Refusing to remove non-regular key file',
    });
    const readiness = async (entry) => {
        const secret = secretFor(entry);
        if (secret !== undefined) return secret.statusPayload();
        try {
            return (await import(pathToFileURL(join(folder, 'providers', `${entry.id}.mjs`)).href)).status();
        } catch {
            return { configured: false, statusLabel: 'Unavailable' };
        }
    };
    return { ...provider, folder, secretFor, readiness };
}

async function snapshot(plugin) {
    const selected = plugin.selectedProvider();
    const providers = [];
    for (const entry of plugin.PROVIDERS) {
        const ready = await plugin.readiness(entry);
        providers.push({ id: entry.id, name: entry.name, selected: entry.id === selected.id, configured: ready.configured === true, statusLabel: ready.statusLabel ?? (ready.configured ? 'Ready' : 'Not configured'), usesKey: entry.secret !== undefined });
    }
    return { selected: selected.id, providers };
}

function printStatus(state) {
    heading('Realtime voice on this computer');
    for (const entry of state.providers) {
        status(`${entry.selected ? '▸ ' : '  '}${entry.name}`, entry.statusLabel, entry.configured ? 'ok' : 'warn');
    }
    const active = state.providers.find((entry) => entry.selected);
    process.stdout.write(active?.configured
        ? '\nClients can start realtime voice. They never see which provider answers.\n'
        : '\nClients will report voice as unavailable until the selected provider is configured here.\n');
}

async function readStdinKey() {
    const raw = readFileSync(0, 'utf8');
    const key = raw.split('\n')[0]?.trim() ?? '';
    if (key === '') throw new Error('no key on stdin');
    return key;
}

export async function configureVoice(args = []) {
    const plugin = await voicePlugin();
    const [command, ...rest] = args;
    try {
        if (command === 'status') {
            const state = await snapshot(plugin);
            if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
            else printStatus(state);
            return 0;
        }
        if (command === 'select') {
            const chosen = plugin.selectProvider(rest[0]);
            process.stdout.write(`Realtime voice provider: ${chosen.name}.\n`);
            printStatus(await snapshot(plugin));
            return 0;
        }
        if (command === 'key') {
            const entry = plugin.selectedProvider();
            const secret = plugin.secretFor(entry);
            if (rest[0] === 'clear') {
                if (secret !== undefined) await secret.clearKey();
                process.stdout.write(`${entry.name}: key removed.\n`);
                return 0;
            }
            if (rest[0] === 'set') {
                if (secret === undefined) throw new Error(`${entry.name} does not use an API key`);
                // Keys never travel in argv: they would land in shell history and process lists.
                const key = rest.includes('--stdin') ? await readStdinKey() : await promptSecret(`${entry.keyLabel} API key for ${entry.name}`);
                if (key === undefined || key === '') throw new Error('no key entered');
                await secret.writeKey(key);
                process.stdout.write(`${entry.name}: key saved owner-only under ${stateDir()}.\n`);
                return 0;
            }
            throw new Error('usage: muxr voice key set [--stdin] | muxr voice key clear');
        }
        if (command !== undefined) throw new Error('usage: muxr voice [status [--json] | select <provider> | key set [--stdin] | key clear]');

        // Interactive: pick, then configure the pick if it needs a key.
        const state = await snapshot(plugin);
        printStatus(state);
        const choice = await select('Which provider should answer realtime voice on this computer?', state.providers.map((entry) => ({
            value: entry.id,
            title: entry.name,
            description: `${entry.statusLabel}${entry.selected ? ' · selected' : ''}`,
        })), Math.max(0, state.providers.findIndex((entry) => entry.selected)));
        if (typeof choice !== 'string') return 0;
        const chosen = plugin.selectProvider(choice);
        const secret = plugin.secretFor(chosen);
        if (secret !== undefined) {
            const current = await secret.statusPayload();
            const action = await select(`${chosen.name} ${current.configured ? 'has a key' : 'needs an API key'}. What now?`, [
                ...(current.configured ? [{ value: 'keep', title: 'Keep the saved key', description: 'nothing changes' }] : []),
                { value: 'set', title: current.configured ? 'Replace the key' : 'Enter the key now', description: 'typed hidden, stored owner-only on this computer' },
                ...(current.configured ? [{ value: 'clear', title: 'Remove the key', description: 'voice becomes unavailable until a key is set' }] : []),
            ]);
            if (action === 'set') {
                const key = await promptSecret(`${chosen.keyLabel} API key`);
                if (key !== undefined && key !== '') await secret.writeKey(key);
            } else if (action === 'clear') {
                await secret.clearKey();
            }
        }
        printStatus(await snapshot(plugin));
        return 0;
    } catch (cause) {
        process.stderr.write(`muxr voice: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        return 1;
    }
}
