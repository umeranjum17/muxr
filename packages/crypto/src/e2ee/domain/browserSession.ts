/**
 * Browser-service private channel: the scope every sealed message between
 * the browser service and one owner device is bound to.
 *
 * The browser service holds its own signing/X25519 identity and mints a
 * second, separately pinned device grant (the "browser-service grant")
 * with per-device roots. Nothing sealed under it is readable with the
 * shared session root the agent-accessible host holds. Session handle,
 * ownership generation and direction are part of the authenticated
 * context, so a message for one session or generation never opens for
 * another.
 */

export type BrowserSessionDirection = 'service->device' | 'device->service';

export interface BrowserSessionScope {
    /** The browser service's own identity id; the `machineId` of its grant. */
    serviceId: string;
    deviceId: string;
    /** Opaque `bsn_` session handle. */
    session: string;
    /** Ownership generation the message belongs to. */
    generation: number;
    /** Key generation of the browser-service grant. */
    keyVersion: number;
}

export function validateBrowserSessionScope(scope: BrowserSessionScope): void {
    if (scope === null || typeof scope !== 'object') throw new Error('browser session: scope required');
    for (const field of ['serviceId', 'deviceId', 'session'] as const) {
        if (typeof scope[field] !== 'string' || scope[field] === '') throw new Error(`browser session: ${field} required`);
    }
    if (!Number.isInteger(scope.generation) || scope.generation < 0) throw new Error('browser session: generation must be a non-negative integer');
    if (!Number.isInteger(scope.keyVersion) || scope.keyVersion < 1) throw new Error('browser session: key generation must be a positive integer');
}

/** Stream identity inside the sealed context: session and generation together. */
export function browserSessionStreamId(scope: BrowserSessionScope): string {
    return `browser-session:${scope.session}:${scope.generation}`;
}
