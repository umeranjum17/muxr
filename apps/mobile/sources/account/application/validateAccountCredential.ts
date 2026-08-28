import {
    AccountCredentialRejectedError,
    accountCredentialIsPresent,
    accountSessionFromHttpStatus,
    type AccountSessionState,
} from '../domain/accountSession';

export type ValidateAccountCredentialCommand = {
    credential: string;
    status: number;
};

/** Empty proof is unavailability. 401 is rejection. Fetch stays in the adapter. */
export function validateAccountCredential(command: ValidateAccountCredentialCommand): AccountSessionState {
    if (!accountCredentialIsPresent(command.credential)) return 'unavailable';
    const outcome = accountSessionFromHttpStatus(command.status);
    if (outcome === 'rejected') throw new AccountCredentialRejectedError();
    return outcome;
}
