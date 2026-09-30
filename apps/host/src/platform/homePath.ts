import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The phone never learns the host's home or working directory, so a path it
 * sends is read from home: `~` and `~/x` expand, and a relative path is
 * relative to home, never to the host process cwd (`/` under launchd).
 */
export function homePath(path: string, home = homedir()): string {
    return resolve(home, path.replace(/^~(?=\/|$)/, '.'));
}
