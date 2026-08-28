import type { Session } from '@/sync/storageTypes';

export type ClaudeForkSource = {
    kind: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

export type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

export type ForkSource = ClaudeForkSource | CodexForkSource;

/** The herdr host does not expose provider rewind ids; fork is a no-op from this client. */
export function getSessionForkSource(_session: Session | undefined): ForkSource | null {
    return null;
}
