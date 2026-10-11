import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestParams, RequestResult } from '@trymuxr/contract';
import { runInProcessGroup } from '../../platform/processGroup.js';

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
    const result = await runInProcessGroup(process.execPath, [cli, 'host-repair', request], {
        timeoutMs: 45_000,
        maxBuffer: 65536,
    });
    let parsed: RequestResult<'host.update'> & { error?: string };
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error('The host could not check or start this update.');
    }
    if (result.error !== null || parsed.error) throw new Error(parsed.error ?? 'Host update failed.');
    return parsed;
}
