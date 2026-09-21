/**
 * Realtime voice, as product code.
 *
 * The provider adapters under ./providers are internal and swappable: this
 * module is the only surface the host and the app call, and it resolves the
 * selected adapter from the fixed table in ./provider.mjs. Nothing here is a
 * plugin contribution, so there is no catalog, approval, or manifest hash in
 * the voice path.
 */
import { reportAgentOutcome } from './coordinatorPolicy.mjs';
import { providerSecret } from './providerSecret.mjs';
import { PROVIDERS, providerById, selectProvider, selectedProvider } from './provider.mjs';

/** Secrets are per provider, so the store is resolved from the current selection. */
function secretFor(provider) {
    if (provider.secret === undefined) return undefined;
    return providerSecret(provider.secret, {
        notDirectory: `${provider.keyLabel} key store must be a real directory`,
        missing: `No ${provider.keyLabel} key. Configure the provider from muxr Settings.`,
        ownerOnly: `${provider.keyLabel} key store must be owner-only`,
        empty: `${provider.keyLabel} key must not be empty`,
        notRegular: 'Refusing to remove non-regular key file',
    });
}

function providerEntry(provider, selected) {
    return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        setup: provider.setup,
        selected: provider.id === selected.id,
        stateLabel: provider.id === selected.id ? 'In use' : '',
    };
}

/** One engine's card for the Settings explainer: what it is, whether it is in use, and whether it is ready. */
export async function voiceProviderDescribe(id) {
    const provider = id === undefined || id === null || String(id).trim() === ''
        ? selectedProvider()
        : providerById(String(id).trim());
    if (provider === undefined) throw new Error('unknown realtime voice provider');
    const selected = selectedProvider();
    const secret = secretFor(provider);
    const readiness = secret === undefined
        ? (await import(`./providers/${provider.id}.mjs`)).status()
        : await secret.statusPayload();
    return {
        ...providerEntry(provider, selected),
        selectedLabel: provider.id === selected.id ? 'In use' : 'Not in use',
        configured: readiness.configured === true,
        statusLabel: readiness.statusLabel,
    };
}

export async function voiceStatus() {
    const provider = selectedProvider();
    const secret = secretFor(provider);
    // An adapter without a key store authenticates some other way and owns its
    // own check; loading it is only worth the import cost in that case.
    const status = secret === undefined
        ? (await import(`./providers/${provider.id}.mjs`)).status()
        : await secret.statusPayload();
    return { ...status, providerId: provider.id, providerName: provider.name, keyLabel: provider.keyLabel };
}

export async function voiceProviderList() {
    const selected = selectedProvider();
    return { selected: selected.id, providers: PROVIDERS.map((entry) => providerEntry(entry, selected)) };
}

export async function voiceProviderSet(providerId) {
    const next = selectProvider(providerId);
    return { selected: next.id, providers: PROVIDERS.map((entry) => providerEntry(entry, next)) };
}

/** The engine a key operation targets: the named one, or the selected one. */
function keyProvider(providerId) {
    if (providerId === undefined || providerId === null || String(providerId).trim() === '') return selectedProvider();
    const provider = providerById(String(providerId).trim());
    if (provider === undefined) throw new Error('unknown realtime voice provider');
    return provider;
}

export async function voiceKeySet(key, providerId) {
    const provider = keyProvider(providerId);
    const secret = secretFor(provider);
    if (secret === undefined) throw new Error(`${provider.name} does not use an API key`);
    await secret.writeKey(key);
}

export async function voiceKeyClear(providerId) {
    const secret = secretFor(keyProvider(providerId));
    if (secret !== undefined) await secret.clearKey();
}

export function voiceReport(input) {
    return { say: reportAgentOutcome(input) };
}
