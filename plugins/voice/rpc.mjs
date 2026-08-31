#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { reportAgentOutcome } from './coordinatorPolicy.mjs';
import { providerSecret } from './providerSecret.mjs';
import { PROVIDERS, selectProvider, selectedProvider } from './provider.mjs';

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

const method = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8') || 'null');
const provider = selectedProvider();
const secret = secretFor(provider);

let output;
if (method === 'status') {
    // An adapter without a key store authenticates some other way and owns its
    // own check; loading it is only worth the import cost in that case.
    const status = secret === undefined
        ? (await import(`./providers/${provider.id}.mjs`)).status()
        : await secret.statusPayload();
    output = { ...status, providerId: provider.id, providerName: provider.name, keyLabel: provider.keyLabel };
} else if (method === 'key.set') {
    if (secret === undefined) throw new Error(`${provider.name} does not use an API key`);
    await secret.writeKey(input?.key);
    output = null;
} else if (method === 'key.clear') {
    if (secret !== undefined) await secret.clearKey();
    output = null;
} else if (method === 'provider.list') {
    output = {
        selected: provider.id,
        providers: PROVIDERS.map(({ id, name }) => ({ id, name, selected: id === provider.id })),
    };
} else if (method === 'provider.set') {
    const next = selectProvider(input?.providerId);
    output = {
        selected: next.id,
        providers: PROVIDERS.map(({ id, name }) => ({ id, name, selected: id === next.id })),
    };
} else if (method === 'report') {
    output = { say: reportAgentOutcome(input) };
} else {
    throw new Error(`unknown muxr Voice method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
