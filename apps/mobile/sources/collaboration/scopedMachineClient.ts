import type { PeerRequestType, RequestParams, RequestResult } from '@trymuxr/contract';
import { MuxrRequestError } from '@/pairing';
import { LinkFirstClient } from '@/pairing/client';
import type { StoredHostedGrant } from '@/pairing/e2ee';
import { getCachedConnectionSettings, savedSshTarget } from '@/connection';
import { sync } from '@/catalog/sync';
import { PeerHostResponseError } from './computerCollaboration';

type ScopedMachineRequestType = PeerRequestType | 'session.start' | 'session.list' | 'session.prompt' | 'herdr.agentKinds';

/** Request one paired machine without changing the app's active connection. */
export async function requestPairedMachine<T extends ScopedMachineRequestType>(
    grant: StoredHostedGrant,
    type: T,
    params: RequestParams<T>,
    timeoutMs = 12_000,
): Promise<RequestResult<T>> {
    if (getCachedConnectionSettings().machineId === grant.machineId) {
        try { return await sync.request(type, params, timeoutMs); }
        catch (cause) {
            if (cause instanceof MuxrRequestError) throw new PeerHostResponseError(cause.message, cause.code);
            throw cause;
        }
    }
    const client = await openPairedMachine(grant);
    try {
        try {
            return await client.request(type, params, timeoutMs);
        } catch (cause) {
            if (cause instanceof MuxrRequestError) throw new PeerHostResponseError(cause.message, cause.code);
            throw cause;
        }
    } finally {
        client.close();
    }
}

/** The native transport owns one tunnel, so a background probe must not replace it. */
export class SshComputerNeedsActivation extends Error {
    constructor() { super('Checked when you pick it'); }
}

/** Open one paired machine's own link without touching the app's active
 * connection. Rejects when the host refuses the pairing permanently or does
 * not answer in time; the caller owns closing the returned client. */
export async function openPairedMachine(grant: StoredHostedGrant): Promise<LinkFirstClient> {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(grant.relayUrl).hostname);
    if (loopback || await savedSshTarget(grant.machineId) !== undefined) throw new SshComputerNeedsActivation();
    let permanentError: string | undefined;
    const client = new LinkFirstClient({
        hostedGrant: grant,
        requestTimeoutMs: 12_000,
        onPermanentError: (message) => { permanentError = message; },
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
                    queueMicrotask(() => reject(permanentError
                        ? new PeerHostResponseError(permanentError, 'e2ee-required')
                        : new Error('computer unavailable')));
                }
            });
            client.connect();
        });
        return client;
    } catch (cause) {
        client.close();
        throw cause;
    }
}
