/**
 * Can this checkout invoke its own packaged close plugin?
 *
 * `session.stop` calls the workspace-hierarchy plugin's close RPC, and the host
 * only trusts a registration whose root is the running host's own plugin
 * directory. A desk that has the packed `dist-npm/` copy linked -- or the
 * globally installed CLI's copy -- registers the same plugin id from a
 * different path, so the checkout's host finds no match and refuses the call.
 * That is the trust anchor working, not a regression, so the e2e checks skip
 * the stop step instead of failing on it.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLOSE_PLUGIN_ID = 'muxr.workspace-hierarchy';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function realOrRaw(path) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** `{ ok: true }`, or `{ ok: false, reason }` naming the root herdr has instead. */
export function packagedCloseAvailable() {
    const expected = realOrRaw(join(repoRoot, 'plugins', CLOSE_PLUGIN_ID.replace('muxr.', '')));
    let registered;
    try {
        const raw = execFileSync(process.env.HERDR_BIN || 'herdr', ['plugin', 'list', '--json'], {
            encoding: 'utf8', timeout: 10_000,
        });
        registered = JSON.parse(raw).result?.plugins
            ?.find((plugin) => plugin.plugin_id === CLOSE_PLUGIN_ID)?.plugin_root;
    } catch (error) {
        return { ok: false, reason: `herdr plugin list failed: ${error.message}` };
    }
    if (registered === undefined) return { ok: false, reason: `herdr has no ${CLOSE_PLUGIN_ID} linked` };
    if (realOrRaw(registered) !== expected) return { ok: false, reason: `herdr links ${registered}` };
    return { ok: true };
}
