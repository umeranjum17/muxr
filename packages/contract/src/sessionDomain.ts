/**
 * Session domain types owned by the machine host.
 *
 * The host computes all of this where the agents actually run. Clients render
 * it and never re-derive it -- re-derivation on the client is what let two
 * session models drift apart in the previous architecture.
 */

import type { SessionInfo, SessionStatus } from './sessionState.js';

// --- unread -----------------------------------------------------------------

export interface SessionUnreadEntry {
    sessionId: string;
    cwd: string;
    unreadCount: number;
    lastActivityAt: string;
}

export interface UnreadCatalog {
    revision: number;
    entries: SessionUnreadEntry[];
}

// --- snapshots --------------------------------------------------------------

/** herdr has no per-agent transcript to page; the terminal is the transcript. */
export interface MessagePage {
    messages: unknown[];
    /** Cursor for the next older page; absent when at the beginning. */
    before?: number;
    hasMore: boolean;
}

/** Everything a client needs to render a session it just opened. */
export interface SessionSnapshot {
    info: SessionInfo;
    status: SessionStatus;
    page: MessagePage;
}

// --- machines ---------------------------------------------------------------

export interface MachineInfo {
    machineId: string;
    name?: string;
    online: boolean;
    lastSeenAt?: string;
    hostVersion?: string;
}
