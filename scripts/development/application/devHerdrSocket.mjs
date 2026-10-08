import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';

function resolvedPath(path) {
    try { return realpathSync(path); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const absolute = resolve(path);
        const parent = dirname(absolute);
        if (parent === absolute) return absolute;
        return join(resolvedPath(parent), basename(absolute));
    }
}

/** Select a development upstream before starting any builds or services. */
export function devHerdrSocket(env = process.env) {
    const defaultPath = join(env.HOME?.trim() || homedir(), '.config', 'herdr', 'herdr.sock');
    const path = env.HERDR_SOCKET_PATH?.trim();
    if (env.MUXR_DEV_ALLOW_DEFAULT_HERDR === '1') return path || defaultPath;
    if (!path || resolvedPath(path) === resolvedPath(defaultPath)) {
        throw new Error('Set HERDR_SOCKET_PATH to a lab session socket; to use your default Herdr session deliberately, set MUXR_DEV_ALLOW_DEFAULT_HERDR=1.');
    }
    return path;
}
