#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { reportInstruction } from '../voice/coordinatorPolicy.mjs';
import { providerSecret } from '../voice/providerSecret.mjs';

const secret = providerSecret('openai.key', {
    notDirectory: 'OpenAI key store must be a real directory',
    missing: 'No OpenAI key. Configure the provider from muxr Settings.',
    ownerOnly: 'OpenAI key store must be owner-only',
    empty: 'OpenAI key must not be empty',
    notRegular: 'Refusing to remove non-regular key file',
});
const method = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8') || 'null');

let output;
if (method === 'status') {
    output = await secret.statusPayload();
} else if (method === 'key.set') {
    await secret.writeKey(input?.key);
    output = null;
} else if (method === 'key.clear') {
    await secret.clearKey();
    output = null;
} else if (method === 'report') {
    output = { say: reportInstruction(input) };
} else {
    throw new Error(`unknown OpenAI Realtime method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
