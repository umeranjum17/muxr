/**
 * Device pairing rendezvous.
 *
 * A new device posts its box public key and polls. An already-authorised device
 * seals the account secret to that key and posts it here. The relay only ever
 * holds the sealed blob, so pairing does not weaken end-to-end encryption.
 */

/** Pairing is a hands-on flow; anything older than this is abandoned. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** Bounds memory when an unauthenticated caller floods the request endpoint. */
const MAX_PENDING = 100;

interface PendingRequest {
    createdAt: number;
    /** Sealed by the approver to the requester's public key. */
    response?: string;
    /** Account token handed to the requester once approved. */
    token?: string;
}

export type PairingState = { state: 'requested' } | { state: 'authorized'; token: string; response: string };

/** A 32-byte key, base64. Rejects anything else so junk cannot fill the map. */
export function isValidPublicKey(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
    try {
        return Buffer.from(value, 'base64').length === 32;
    } catch {
        return false;
    }
}

export class PairingRequests {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly now: () => number = Date.now) {}

    private sweep(): void {
        const cutoff = this.now() - PENDING_TTL_MS;
        for (const [key, request] of this.pending) {
            if (request.createdAt < cutoff) this.pending.delete(key);
        }
    }

    /** Create-or-read: the client posts the same request to start and to poll. */
    request(publicKey: string): PairingState | undefined {
        this.sweep();
        const existing = this.pending.get(publicKey);
        if (existing !== undefined) {
            return existing.response === undefined || existing.token === undefined
                ? { state: 'requested' }
                : { state: 'authorized', token: existing.token, response: existing.response };
        }
        if (this.pending.size >= MAX_PENDING) return undefined;
        this.pending.set(publicKey, { createdAt: this.now() });
        return { state: 'requested' };
    }

    /** Returns false when the request expired or was never started. */
    approve(publicKey: string, response: string, token: string): boolean {
        this.sweep();
        const existing = this.pending.get(publicKey);
        if (existing === undefined) return false;
        existing.response = response;
        existing.token = token;
        return true;
    }

    get size(): number {
        return this.pending.size;
    }
}
