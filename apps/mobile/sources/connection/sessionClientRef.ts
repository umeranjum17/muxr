import type { SessionClient } from '@/pairing/client';

/**
 * The one live machine connection, shared with code that runs outside the
 * session sync (push registration rides whichever transport is serving it).
 * The sync controller owns the lifecycle; everyone else only reads.
 */
let active: SessionClient | undefined;

export function setActiveSessionClient(client: SessionClient | undefined): void {
    active = client;
}

export function activeSessionClient(): SessionClient | undefined {
    return active;
}
