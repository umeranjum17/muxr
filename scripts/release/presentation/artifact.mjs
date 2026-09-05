#!/usr/bin/env node
import { sealRelease } from '../application/sealRelease.mjs';
import { verifyRelease } from '../application/verifyRelease.mjs';
import { readFileSync } from 'node:fs';

const [action, path] = process.argv.slice(2);
try {
    if (!['seal', 'verify'].includes(action) || !path || process.argv.length !== 4) throw new Error('Usage: artifact.mjs seal|verify request.json');
    const request = JSON.parse(readFileSync(path, 'utf8'));
    const result = action === 'seal' ? await sealRelease(request) : await verifyRelease(request);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
}
