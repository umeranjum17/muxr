import type { PeerRequestMap, PeerRequestType } from '@muxr/contract';
import { MuxrClient, MuxrRequestError } from '@/client/muxrClient';
import type { StoredHostedGrant } from '@/state/hostedE2ee';
import { PeerHostResponseError } from './computerCollaboration';

/** Request one paired machine without changing the app's active connection. */
export async function requestPairedMachine<T extends PeerRequestType>(
    grant: StoredHostedGrant,
    type: T,
    params: PeerRequestMap[T]['params'],
): Promise<PeerRequestMap[T]['result']> {
    const client = new MuxrClient({
        mode: 'hosted',
        relayUrl: grant.relayUrl,
        machineId: grant.machineId,
        token: grant.credential,
        hostedGrant: grant,
        requestTimeoutMs: 12_000,
        reconnectDelayMs: 30_000,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                unsubscribe();
                reject(new Error('computer unavailable'));
            }, 12_000);
            const unsubscribe = client.onStateChange((state) => {
                if (state === 'open') {
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve();
                } else if (state === 'stale') {
                    clearTimeout(timeout);
                    unsubscribe();
                    reject(new Error('computer unavailable'));
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
