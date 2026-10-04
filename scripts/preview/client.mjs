import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLIENT_TIMEOUT_MS = 45_000;

function authFile() {
    const home = process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr');
    return process.env.MUXR_NAMING_AUTH_FILE?.trim() || join(home, 'naming', 'token');
}

/**
 * Whether the phone is driving this pane's browser, emulator, or simulator right now.
 * The pane identity comes from HERDR_PANE_ID over the same authenticated
 * loopback as `muxr name`; a pane can only ever read its own lease.
 * Prints `human` or `none`, or the JSON record with --json.
 */
export async function previewStatus(args) {
    let json = false;
    for (const flag of args) {
        if (flag !== '--json') throw new Error('usage: muxr preview status [--json]');
        json = true;
    }
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (paneId === undefined || paneId === '') throw new Error('muxr preview status must run inside a Herdr pane (HERDR_PANE_ID is missing)');

    let token;
    try {
        token = readFileSync(authFile(), 'utf8').trim();
    } catch {
        throw new Error('muxr preview status is unavailable; start the local muxr host first');
    }
    if (token === '') throw new Error('muxr preview status authorization is unavailable');

    const port = Number(process.env.MUXR_NAMING_PORT ?? 8797);
    const response = await fetch(`http://127.0.0.1:${port}/api/preview-status?pane_id=${encodeURIComponent(paneId)}`, {
        headers: {
            authorization: `Bearer ${token}`,
            origin: 'muxr://agent',
            'x-muxr-pane-id': paneId,
        },
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || (result.controller !== 'human' && result.controller !== 'none')) {
        throw new Error(String(result.error ?? '') || `preview status request failed (${response.status})`);
    }
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.controller}\n`);
    return 0;
}
