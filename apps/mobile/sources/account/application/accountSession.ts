import { relayControlUrl } from '@muxr/contract';
import {
    AccountCredentialRejectedError,
    accountCredentialIsPresent,
    accountSessionFromHttpStatus,
    type AccountSessionState,
} from '../domain/accountSession';

/** Account authentication is independent from any machine grant or relay ticket. */
export async function validateHostedAccountSession(
    relayUrl: string,
    credential: string,
    timeoutMs = 10_000,
): Promise<AccountSessionState> {
    if (!accountCredentialIsPresent(credential)) return 'unavailable';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(relayControlUrl(relayUrl, '/v1/session'), {
            headers: { authorization: `Bearer ${credential}` },
            signal: controller.signal,
        });
        const outcome = accountSessionFromHttpStatus(response.status);
        if (outcome === 'rejected') throw new AccountCredentialRejectedError();
        return outcome;
    } catch (error) {
        if (error instanceof AccountCredentialRejectedError) throw error;
        return 'unavailable';
    } finally {
        clearTimeout(timer);
    }
}
