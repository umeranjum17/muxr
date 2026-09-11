import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestParams, RequestResult } from '@muxr/contract';

/** Resolve only the running installation, never a client path or shell command. */
export async function repairHost(params: RequestParams<'host.update'>, owner: string): Promise<RequestResult<'host.update'>> {
    let directory = dirname(process.argv[1] ?? '');
    let cli: string | undefined;
    for (let n = 0; n < 6; n++) {
        try {
            const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
            if (pkg.name === '@trymuxr/cli' && existsSync(join(directory, 'cli.mjs'))) { cli = join(directory, 'cli.mjs'); break; }
        } catch { /* source checkouts intentionally do not support installation changes */ }
        const parent = dirname(directory); if (parent === directory) break; directory = parent;
    }
    if (!cli) throw new Error('Phone host updates require a packaged installation. Use muxr update on this host first.');
    const request = JSON.stringify({ ...params, owner });
    if (request.length > 2048) throw new Error('Invalid host update request.');
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [cli!, 'host-repair', request], { timeout: 45000, maxBuffer: 65536 }, (error, stdout) => {
            try {
                const result = JSON.parse(stdout);
                if (error || result.error) { reject(new Error(result.error || 'Host update failed.')); return; }
                resolve(result);
            } catch { reject(new Error('The host could not check or start this update.')); }
        });
    });
}
