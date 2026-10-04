/** `muxr preview claim <udid>` / `muxr preview release` — offer this pane's iOS simulator to the phone. */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * One file per pane under `$MUXR_HOME/preview/simulators/`, holding the UDID.
 * The host offers the simulator only while it is booted and the pane lives,
 * so a claim left behind by a closed pane offers nothing.
 */
function claimFile() {
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (!paneId) throw new Error('run inside a Herdr pane (HERDR_PANE_ID is missing)');
    if (paneId === '.' || paneId === '..' || /[/\\]/.test(paneId)) throw new Error('invalid pane');
    const home = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    const dir = join(home, 'preview', 'simulators');
    return { dir, file: join(dir, paneId) };
}

export function previewClaim(args) {
    const [udid, ...rest] = args;
    if (udid === undefined || rest.length > 0 || !UDID.test(udid)) throw new Error('usage: muxr preview claim <simulator-udid>');
    const { dir, file } = claimFile();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${udid.toUpperCase()}\n`, { mode: 0o600 });
    process.stdout.write('claimed: the phone can watch this simulator from this pane while it is booted\n');
    return 0;
}

export function previewRelease(args) {
    if (args.length > 0) throw new Error('usage: muxr preview release');
    rmSync(claimFile().file, { force: true });
    process.stdout.write('released\n');
    return 0;
}
