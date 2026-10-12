import { publicRelayUrl } from './connection.js';
import { accepted, rejected, type Result } from './result.js';

export type Enrollment = {
    id: string;
    claim: string;
    relay: string;
    /** The shared relay's one-use link enrolment token, claimed by the machine's host registration. */
    link?: string;
    /** The origin serving the browser client, when the relay hosts it. */
    web?: string;
};

/** A relay a machine may enroll with: any wss:// relay, or a ws:// relay on this
 *  machine's loopback, where TLS would add nothing. */
function enrollableRelay(value: unknown): string | undefined {
    const relay = publicRelayUrl(value);
    if (relay === undefined) return undefined;
    const { protocol, hostname } = new URL(relay);
    return protocol === 'wss:' || ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? relay : undefined;
}

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
        const relay = enrollableRelay(payload.relay);
        if (payload.v !== 1 || typeof payload.id !== 'string' || typeof payload.claim !== 'string' || relay === undefined) {
            return rejected('enrollment must be the muxr://enroll string created on the relay server');
        }
        if (payload.link !== undefined && typeof payload.link !== 'string') {
            return rejected('enrollment must be the muxr://enroll string created on the relay server');
        }
        if (typeof payload.expires === 'number' && payload.expires <= Date.now()) {
            return rejected('this enrollment has expired; ask for a new one');
        }
        return accepted({
            id: payload.id,
            claim: payload.claim,
            relay,
            ...(typeof payload.link === 'string' && payload.link !== '' ? { link: payload.link } : {}),
            ...(typeof payload.web === 'string' ? { web: new URL(payload.web).origin } : {}),
        });
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
