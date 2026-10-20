import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile } from '../../platform/persist.js';

/** How long one minted TURN credential stays valid; a desktop session renews by opening again. */
const TURN_TTL_SECONDS = 12 * 60 * 60;

export interface IceServer { urls: string[]; username?: string; credential?: string }

/**
 * The owner's own TURN/STUN servers, from `turn.json` in the relay data dir:
 * `{ "urls": ["turn:host:3478?transport=udp", ...], "secret": "<coturn static-auth-secret>" }`.
 * Read on every request, so writing the file needs no relay restart. Absent
 * means none: muxr never falls back to a public STUN or TURN server.
 */
export async function readTurnConfig(dataDir: string): Promise<{ urls: string[]; secret?: string } | undefined> {
    const raw = await readPrivateFile(join(dataDir, 'turn.json'));
    if (raw === undefined) return undefined;
    let parsed: { urls?: unknown; secret?: unknown };
    try { parsed = JSON.parse(raw) as { urls?: unknown; secret?: unknown }; }
    catch { throw new Error('turn.json is not valid JSON'); }
    const urls = Array.isArray(parsed.urls) ? parsed.urls.filter((url): url is string => typeof url === 'string' && /^(turns?|stun):/.test(url)) : [];
    if (urls.length === 0) throw new Error('turn.json names no turn:, turns: or stun: URL');
    const secret = typeof parsed.secret === 'string' && parsed.secret !== '' ? parsed.secret : undefined;
    if (secret === undefined && urls.some((url) => !url.startsWith('stun:'))) throw new Error('turn.json has TURN URLs but no secret');
    return { urls, ...(secret === undefined ? {} : { secret }) };
}

/**
 * Per-session credentials in the TURN REST shape coturn checks with
 * `use-auth-secret`: the username is `<expiry>:<who>`, the password its
 * HMAC-SHA1 under the shared secret. The secret itself never leaves the relay.
 */
export function mintIceServers(turn: { urls: string[]; secret?: string }, who: string, nowMs: number): IceServer[] {
    const stun = turn.urls.filter((url) => url.startsWith('stun:'));
    const relayed = turn.urls.filter((url) => !url.startsWith('stun:'));
    const iceServers: IceServer[] = stun.length === 0 ? [] : [{ urls: stun }];
    if (relayed.length > 0 && turn.secret !== undefined) {
        const username = `${Math.floor(nowMs / 1000) + TURN_TTL_SECONDS}:${who}`;
        iceServers.push({ urls: relayed, username, credential: createHmac('sha1', turn.secret).update(username).digest('base64') });
    }
    return iceServers;
}
