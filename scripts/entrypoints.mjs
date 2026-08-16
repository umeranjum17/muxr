// Where the relay and host live, in either layout: the repo's built output under
// apps/<name>/dist, or the published package where they sit beside this file.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function resolve(packagedName, repoPath) {
    const packaged = join(here, packagedName);
    return existsSync(packaged) ? packaged : repoPath;
}

export const relayEntry = resolve('relay.js', 'apps/relay/dist/main.js');
export const hostEntry = resolve('host.js', 'apps/host/dist/main.js');
