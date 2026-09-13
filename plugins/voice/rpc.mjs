#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { reportAgentOutcome } from './coordinatorPolicy.mjs';
import { providerSecret } from './providerSecret.mjs';
import { selectedProvider } from './provider.mjs';

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
    // Clients learn readiness only. Which provider answers, which account,
    // which model and which key are host matters (`muxr voice`).
    const status = secret === undefined
        ? (await import(`./providers/${provider.id}.mjs`)).status()
        : await secret.statusPayload();
    const configured = status.configured === true;
    output = { configured, statusLabel: configured ? 'Ready' : 'Not configured on this computer' };
} else if (method === 'report') {
    output = { say: reportAgentOutcome(input) };
} else {
    throw new Error(`unknown muxr Voice method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
