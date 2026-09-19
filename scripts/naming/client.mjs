import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const fields = new Set(['workspace', 'pane', 'provider', 'model']);
const CLIENT_TIMEOUT_MS = 45_000;

function authFile() {
    const home = process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr');
    return process.env.MUXR_NAMING_AUTH_FILE?.trim() || join(home, 'naming', 'token');
}

function valueFor(args, index, flag) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
}

export async function nameAgent(args) {
    const body = {};
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (!flag.startsWith('--') || !fields.has(flag.slice(2))) {
            throw new Error('usage: muxr name [--workspace LABEL] [--pane TITLE] [--provider PROVIDER] [--model MODEL]');
        }
        body[flag.slice(2)] = valueFor(args, index, flag);
        index += 1;
    }
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (paneId === undefined || paneId === '') throw new Error('muxr name must run inside a Herdr pane (HERDR_PANE_ID is missing)');
    if (Object.keys(body).length === 0) throw new Error('muxr name needs at least one name or metadata value');

    let token;
    try {
        token = readFileSync(authFile(), 'utf8').trim();
    } catch {
        throw new Error('muxr naming is not running; start the local muxr host first');
    }
    if (token === '') throw new Error('muxr naming authorization is unavailable');

    const port = Number(process.env.MUXR_NAMING_PORT ?? 8797);
    const response = await fetch(`http://127.0.0.1:${port}/api/naming`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            origin: 'muxr://agent',
            'x-muxr-pane-id': paneId,
            ...(process.env.HERDR_SESSION?.trim() ? { 'x-herdr-session': process.env.HERDR_SESSION.trim() } : {}),
        },
        body: JSON.stringify({ pane_id: paneId, ...body }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
        const operationErrors = Object.entries(result.errors ?? {})
            .map(([operation, error]) => `${operation}: ${String(error)}`)
            .join('; ');
        const detail = [result.error, result.status, operationErrors].filter(Boolean).join(' — ');
        throw new Error(detail || `naming request failed (${response.status})`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
}
