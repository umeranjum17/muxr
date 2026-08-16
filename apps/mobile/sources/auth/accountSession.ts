import { relayControlUrl } from '@muxr/contract';

export type AccountSessionState = 'valid' | 'unavailable';

export class AccountCredentialRejectedError extends Error {
    constructor() {
        super('account credential rejected');
        this.name = 'AccountCredentialRejectedError';
    }
}

/** Account authentication is independent from any machine grant or relay ticket. */
export async function validateHostedAccountSession(
    relayUrl: string,
    credential: string,
    timeoutMs = 10_000,
): Promise<AccountSessionState> {
    if (credential.trim() === '') return 'unavailable';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(relayControlUrl(relayUrl, '/v1/session'), {
            headers: { authorization: `Bearer ${credential}` },
            signal: controller.signal,
        });
        if (response.status === 401) throw new AccountCredentialRejectedError();
        return response.ok ? 'valid' : 'unavailable';
    } catch (error) {
        if (error instanceof AccountCredentialRejectedError) throw error;
        return 'unavailable';
    } finally {
        clearTimeout(timer);
    }
}

export function canStartHostedTransport(
    machineId: string,
    grant: { machineId: string } | undefined,
): boolean {
    const normalized = machineId.trim();
    return normalized !== '' && grant?.machineId === normalized;
}
