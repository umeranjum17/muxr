/**
 * Lightweight RequestMap check for CI. Asserts the plugin bridge types exist
 * in the candidate contract. The full delivery gate is still
 * `node scripts/diagnostics/application/checkHostContract.mjs <commit> <hostReleaseDir>`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['plugin.list', 'plugin.manifest', 'plugin.approve', 'plugin.invoke', 'plugin.call'];
const KEY_LINE = /^\s*'([A-Za-z0-9.]+)':/;
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(join(root, 'packages/contract/src/control-plane/domain/requests.ts'), 'utf8');

const keys = new Set();
let capturing = false;
for (const line of source.split('\n')) {
    if (line.includes('export interface RequestMap')) capturing = true;
    if (capturing && line.startsWith('}')) break;
    const match = line.match(KEY_LINE);
    if (match) keys.add(match[1]);
}

if (keys.size < 10) {
    process.stderr.write(`FAIL: could not parse RequestMap (got ${keys.size} keys)\n`);
    process.exit(1);
}

const missing = REQUIRED.filter((type) => !keys.has(type));
if (missing.length > 0) {
    process.stderr.write(`FAIL: plugin bridge missing from RequestMap: ${missing.join(', ')}\n`);
    process.exit(1);
}

process.stdout.write(`ok  plugin bridge (${REQUIRED.join(', ')})\n`);
