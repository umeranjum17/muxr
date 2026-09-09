import { publicRelayUrl } from './connection.js';
import { accepted, rejected, type Result } from './result.js';

export type Enrollment = {
    id: string;
    claim: string;
    relay: string;
};

export function parseEnrollment(link: unknown): Result<Enrollment> {
    if (typeof link !== 'string') return rejected('enrollment must be the muxr://enroll string created on the relay server');
    try {
        const parsed = new URL(link.trim());
        if (parsed.protocol !== 'muxr:' || parsed.hostname !== 'enroll') {
            return rejected('enrollment must be the muxr://enroll string created on the relay server');
        }
        const compact = parsed.searchParams.get('payload');
        if (compact === null) return rejected('enrollment must be the muxr://enroll string created on the relay server');
        const payload = JSON.parse(Buffer.from(compact, 'base64url').toString('utf8')) as Record<string, unknown>;
        const relay = publicRelayUrl(payload.relay);
        if (payload.v !== 1 || typeof payload.id !== 'string' || typeof payload.claim !== 'string' || relay === undefined) {
            return rejected('enrollment must be the muxr://enroll string created on the relay server');
        }
        if (!relay.startsWith('wss://')) return rejected('enrollment must be the muxr://enroll string created on the relay server');
        if (typeof payload.expires === 'number' && payload.expires <= Date.now()) {
            return rejected('enrollment must be the muxr://enroll string created on the relay server');
        }
        return accepted({ id: payload.id, claim: payload.claim, relay });
    } catch {
        return rejected('enrollment must be the muxr://enroll string created on the relay server');
    }
}

export type PendingRemote = {
    version: 1;
    relayLocation: 'remote';
    machineCredential: string;
    credentialExpiresAt: string;
};

export function parsePendingRemote(raw: unknown, now = Date.now()): Result<PendingRemote> {
    if (typeof raw !== 'object' || raw === null) return rejected('pending remote enrollment is invalid or expired; create a fresh enrollment on the relay server');
    const pending = raw as Record<string, unknown>;
    if (pending.version !== 1 || pending.relayLocation !== 'remote' || typeof pending.machineCredential !== 'string') {
        return rejected('pending remote enrollment is invalid or expired; create a fresh enrollment on the relay server');
    }
    if (typeof pending.credentialExpiresAt !== 'string' || Date.parse(pending.credentialExpiresAt) <= now) {
        return rejected('pending remote enrollment is invalid or expired; create a fresh enrollment on the relay server');
    }
    return accepted({
        version: 1,
        relayLocation: 'remote',
        machineCredential: pending.machineCredential,
        credentialExpiresAt: pending.credentialExpiresAt,
    });
}
