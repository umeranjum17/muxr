import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function diagnosticsPath() {
    return join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'host', 'diagnostics.json');
}

export function runDiagnostics() {
    const path = diagnosticsPath();
    if (!existsSync(path)) throw new Error('no host diagnostics yet; start muxr and try again');
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('host diagnostics must be a regular owner-only file');
    }
    let state;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('host diagnostics are malformed; restart muxr to recreate them'); }
    if (state?.version !== 1 || typeof state.current !== 'object' || !Array.isArray(state.events)) {
        throw new Error('host diagnostics use an unsupported schema; update muxr');
    }
    process.stdout.write(`${JSON.stringify({
        note: 'recentClients are unique clients seen during the 15-minute window ending at current.updatedAt, not exact live sockets',
        ...state,
    }, null, 2)}\n`);
}
