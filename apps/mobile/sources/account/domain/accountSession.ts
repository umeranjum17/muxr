export type AccountSessionState = 'valid' | 'unavailable';

/** Proof of the person's muxr account. Independent of any Hosted Grant. */
export interface AuthCredentials {
    token: string;
    secret: string;
}

export class AccountCredentialRejectedError extends Error {
    constructor() {
        super('account credential rejected');
        this.name = 'AccountCredentialRejectedError';
    }
}

/** Empty proof is unavailability, not a 401 rejection. */
export function accountCredentialIsPresent(credential: string): boolean {
    return credential.trim() !== '';
}

/**
 * 401 is rejection of the Account Credential. Any other unsuccessful status
 * is unavailability (relay down, timeout mapped by the caller, etc.).
 */
export function accountSessionFromHttpStatus(status: number): AccountSessionState | 'rejected' {
    if (status === 401) return 'rejected';
    if (status >= 200 && status < 300) return 'valid';
    return 'unavailable';
}
