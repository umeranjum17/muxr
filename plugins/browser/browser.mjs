#!/usr/bin/env node
/** Read-only descriptor for the packaged Browser surface claimant. */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(input)) {
        if (key !== 'cwd') throw new Error('unknown browser descriptor input');
    }
}

process.stdout.write(`${JSON.stringify({
    name: 'Browser',
    capabilities: ['surface.browser.open'],
    note: 'Host-local web apps open through a leased surface offer; this descriptor grants no browsing authority by itself.',
})}\n`);
