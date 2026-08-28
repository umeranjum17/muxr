#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { reportAgentOutcome } from '../voice/coordinatorPolicy.mjs';
import { providerSecret } from '../voice/providerSecret.mjs';

const secret = providerSecret('gemini.key', {
    notDirectory: 'Gemini key store must be a real directory',
    missing: 'No Gemini key. Configure the provider from muxr Settings.',
    ownerOnly: 'Gemini key store must be owner-only',
    empty: 'Gemini key must not be empty',
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
    output = { say: reportAgentOutcome(input) };
} else {
    throw new Error(`unknown Gemini Live method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
