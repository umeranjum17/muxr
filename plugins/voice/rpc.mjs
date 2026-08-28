#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { reportInstruction } from './coordinatorPolicy.mjs';
import { providerSecret } from './providerSecret.mjs';

const secret = providerSecret('xai.key', {
    notDirectory: 'xAI key store must be a real directory',
    missing: 'No xAI key. Configure the provider from muxr Settings.',
    ownerOnly: 'xAI key store must be owner-only',
    empty: 'xAI key must not be empty',
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
    throw new Error(`unknown muxr Voice method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
