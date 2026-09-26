import { connectionShouldAdoptGrant, pickGrantForConnection } from '../domain/hostedGrant';

export type RestoreConnectionCommand = {
    mode: 'hosted';
    machineId: string;
    relayUrl: string;
    selfhost?: boolean;
};

export type RestoreConnectionGrant = {
    machineId: string;
    relayUrl: string;
    source?: 'selfhost';
};

export type RestoreConnectionResult<T extends RestoreConnectionGrant> =
    | { ok: false; reason: 'no-grant' }
    | { ok: true; grant: T; adopt: boolean };

/** Restore the active Connection from a stored Hosted Grant. The grant owns authority. */
export function restoreConnection<T extends RestoreConnectionGrant>(
    command: RestoreConnectionCommand,
    grants: readonly T[],
): RestoreConnectionResult<T> {
    const grant = pickGrantForConnection(command, grants);
    if (grant === undefined) return { ok: false, reason: 'no-grant' };
    return { ok: true, grant, adopt: connectionShouldAdoptGrant(command, grant) };
}
