import type { PeerRequestMap, PeerRequestType } from '@muxr/contract';
import { MuxrClient, MuxrRequestError } from '@/pairing';
import type { StoredHostedGrant } from '@/pairing/e2ee';
import { getCachedConnectionSettings } from '@/connection';
import { sync } from '@/catalog/sync';
import { PeerHostResponseError } from '../application/computerCollaboration';

/** Request one paired machine without changing the app's active connection. */
export async function requestPairedMachine<T extends PeerRequestType>(
    grant: StoredHostedGrant,
    type: T,
    params: PeerRequestMap[T]['params'],
): Promise<PeerRequestMap[T]['result']> {
    if (getCachedConnectionSettings().machineId === grant.machineId) {
        try { return await sync.request(type, params, 12_000); }
        catch (cause) {
            if (cause instanceof MuxrRequestError) throw new PeerHostResponseError(cause.message, cause.code);
            throw cause;
        }
    }
    let permanentError: string | undefined;
    let ticketRejected = false;
    const client = new MuxrClient({
        mode: 'hosted',
        relayUrl: grant.relayUrl,
        machineId: grant.machineId,
        token: grant.credential,
        hostedGrant: grant,
        requestTimeoutMs: 12_000,
        reconnectDelayMs: 30_000,
        onTicketRejected: () => { ticketRejected = true; },
        onPermanentError: (message) => { permanentError = message; },
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                unsubscribe();
                reject(ticketRejected
                    ? new PeerHostResponseError('The computer pairing was rejected.', 'e2ee-required')
                    : new Error('computer unavailable'));
            }, 12_000);
            const unsubscribe = client.onStateChange((state) => {
                if (state === 'open') {
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve();
                } else if (state === 'stale') {
                    clearTimeout(timeout);
                    unsubscribe();
                    queueMicrotask(() => reject(permanentError
                        ? new PeerHostResponseError(permanentError, 'e2ee-required')
                        : new Error('computer unavailable')));
                }
            });
            client.connect();
        });
        try {
            return await client.request(type, params);
        } catch (cause) {
            if (cause instanceof MuxrRequestError) throw new PeerHostResponseError(cause.message, cause.code);
            throw cause;
        }
    } finally {
        client.close();
    }
}
