import { createHash } from 'node:crypto';
import type { PeerMutationMetadata } from '@muxr/contract';
import { PeerStore, type StoredPeerReceipt } from './store.js';

const PEER_MUTATION_MAX_TTL_MS = 5 * 60_000;

function operationError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

/** Durable idempotency boundary for peer mutations. */
export class PeerReceiptExecutor {
    private readonly inFlight = new Map<string, { requestHash: string; promise: Promise<unknown> }>();

    constructor(private readonly store: PeerStore, private readonly now: () => number) {}

    async execute<T>(
        deviceId: string,
        type: string,
        mutation: PeerMutationMetadata,
        request: unknown,
        operation: () => Promise<T>,
    ): Promise<T> {
        const now = this.now();
        if (mutation === null || typeof mutation !== 'object' || typeof mutation.operationId !== 'string'
            || mutation.operationId === '' || mutation.operationId.length > 160 || !Number.isFinite(mutation.notValidAfter)) {
            throw operationError('peer mutation metadata is invalid', 'peer-mutation-invalid');
        }
        if (mutation.notValidAfter <= now) throw operationError('peer mutation expired before dispatch', 'peer-mutation-expired');
        if (mutation.notValidAfter > now + PEER_MUTATION_MAX_TTL_MS) {
            throw operationError('peer mutation validity window is too long', 'peer-mutation-invalid');
        }
        const requestHash = createHash('sha256').update(JSON.stringify({ type, request })).digest('base64url');
        const key = `${deviceId}\0${mutation.operationId}`;
        const running = this.inFlight.get(key);
        if (running !== undefined) {
            if (running.requestHash !== requestHash) throw operationError('peer operation id was reused with different input', 'peer-operation-conflict');
            return running.promise as Promise<T>;
        }
        const receipt = this.store.receipt(deviceId, mutation.operationId);
        if (receipt !== undefined) return this.result<T>(receipt, requestHash);
        const promise = (async () => {
            await this.store.putReceipt({
                deviceId,
                operationId: mutation.operationId,
                requestHash,
                notValidAfter: mutation.notValidAfter,
                state: 'started',
            });
            try {
                const data = await operation();
                await this.store.putReceipt({
                    deviceId, operationId: mutation.operationId, requestHash,
                    notValidAfter: mutation.notValidAfter, state: 'completed', outcome: { ok: true, data },
                });
                return data;
            } catch (error) {
                const code = (error as { code?: unknown }).code;
                const outcome = {
                    ok: false as const,
                    error: error instanceof Error ? error.message : String(error),
                    ...(typeof code === 'string' ? { code } : {}),
                };
                await this.store.putReceipt({
                    deviceId, operationId: mutation.operationId, requestHash,
                    notValidAfter: mutation.notValidAfter, state: 'completed', outcome,
                });
                throw operationError(outcome.error, outcome.code ?? 'peer-operation-failed');
            } finally {
                this.inFlight.delete(key);
            }
        })();
        this.inFlight.set(key, { requestHash, promise });
        return promise;
    }

    private result<T>(receipt: StoredPeerReceipt, requestHash: string): T {
        if (receipt.requestHash !== requestHash) throw operationError('peer operation id was reused with different input', 'peer-operation-conflict');
        if (receipt.state !== 'completed' || receipt.outcome === undefined) {
            throw operationError('peer operation may have executed; it will not be retried', 'peer-operation-uncertain');
        }
        if (receipt.outcome.ok) return receipt.outcome.data as T;
        throw operationError(receipt.outcome.error, receipt.outcome.code ?? 'peer-operation-failed');
    }
}
